import BizError from '../error/biz-error';
import userService from './user-service';
import emailUtils from '../utils/email-utils';
import domainUtils from '../utils/domain-uitls';
import { isDel, settingConst, userConst } from '../const/entity-const';
import JwtUtils from '../utils/jwt-utils';
import { v4 as uuidv4 } from 'uuid';
import KvConst from '../const/kv-const';
import constant from '../const/constant';
import userContext from '../security/user-context';
import verifyUtils from '../utils/verify-utils';
import accountService from './account-service';
import settingService from './setting-service';
import saltHashUtils from '../utils/crypto-utils';
import cryptoUtils from '../utils/crypto-utils';
import turnstileService from './turnstile-service';
import roleService from './role-service';
import regKeyService from './reg-key-service';
import dayjs from 'dayjs';
import { toUtc } from '../utils/date-uitil';
import { t } from '../i18n/i18n.js';
import verifyRecordService from './verify-record-service';
import limitUtils from '../utils/limit-utils';
import reqUtils from '../utils/req-utils';
import securityLog from '../utils/security-log';
import eciesUtils from '../utils/crypto-ecies';

// 同一账号连续失败多少次后，登录必须过人机验证
const LOGIN_CAPTCHA_THRESHOLD = 3;

const loginService = {

	async register(c, params, oauth = false) {

		let { email, password, token, code } = params;

		// 与登录同一套：注册的密码也可能是应用层加密过的
		if (eciesUtils.isEncrypted(password)) {
			const plain = await eciesUtils.decrypt(c, password);

			if (plain === null) {
				throw new BizError(t('pwdDecryptFail'));
			}

			password = plain;
		}

		let { regKey, register, registerVerify, regVerifyCount, minEmailPrefix, emailPrefixFilter } = await settingService.query(c)

		// oauth 分支**不再改写任何开关**。
		//
		// 这里原来做了两件事，都是错的：
		//   1. registerVerify = CLOSE —— 强制跳过人机验证。等于管理员在后台设的
		//      「始终要求验证码」对 OAuth 首登完全失效，可以拿第三方小号无限建号。
		//   2. register = OPEN —— 已在上一轮移除，同理，注册开关必须被遵守。
		// 现在 register / registerVerify 一律按后台设置执行；OAuth 绑定对话框
		// 里也会显示人机验证控件（见 views/login）。

		if (register === settingConst.register.CLOSE) {
			throw new BizError(t('regDisabled'));
		}

		// 建号频次限制：**只统计成功建号**，不统计尝试。
		// 原来 /register 没有任何频次限制，默认配置下（不要注册码、不要验证码）
		// 一个脚本就能无限刷号。OAuth 建号同样走这里，所以一并受控。
		//
		// 为什么不在这里计数：这个函数前面还有一大堆校验（密码长度、邮箱占用、
		// 人机验证、注册码、域名白名单），任何一条失败都会提前 throw。若把
		// "每次调用"都算成一次，家庭/办公室/NAT 共用出口时，几次表单填错就会把
		// 后面正常的人挡在门外。要限制的是"建号速率"，不是"尝试次数"。
		const registerIp = reqUtils.getIp(c);
		await limitUtils.assertNotLocked(c, 'register:ip', registerIp);

		if (!verifyUtils.isEmail(email)) {
			throw new BizError(t('notEmail'));
		}

		// 禁止在注册时使用 `+` 别名（安全修复，别删）。
		//
		// 收信是「先按完整地址精确匹配，匹配不到才回退到 + 前面的基础地址」。
		// 所以只要放行，任何人都能抢先注册 `别人+任意标签@域名`，
		// 把自己变成那个别名的收件人 —— 而 `+标签` 恰恰是很多服务用来区分
		// 注册来源的常规写法（victim+github@、victim+paypal@），
		// 抢注一批就能持续截收别人的验证邮件与找回邮件。
		//
		// 别名本质上是从属地址，只能创建在「基础地址归属可验证」的地方，
		// 也就是 /account/add（那里会校验基础地址属于同一个用户）。
		if (emailUtils.getName(email).includes('+')) {
			throw new BizError(t('aliasNotAllowed'));
		}

		if (emailUtils.getName(email).length < minEmailPrefix) {
			throw new BizError(t('minEmailPrefix', { msg: minEmailPrefix } ));
		}

		if (emailPrefixFilter.some(content => emailUtils.getName(email).includes(content)))  {
			throw new BizError(t('banEmailPrefix'));
		}

		if (emailUtils.getName(email).length > 64) {
			throw new BizError(t('emailLengthLimit'));
		}

		if (password.length > 30) {
			throw new BizError(t('pwdLengthLimit'));
		}

		if (password.length < 6) {
			throw new BizError(t('pwdMinLength'));
		}

		if (!domainUtils.isAllowedEmailDomain(c, email)) {
			throw new BizError(t('notEmailDomain'));
		}

		let type = null;
		let regKeyId = 0

		if (regKey === settingConst.regKey.OPEN) {
			const result = await this.handleOpenRegKey(c, regKey, code)
			type = result?.type
			regKeyId = result?.regKeyId
		}

		if (regKey === settingConst.regKey.OPTIONAL) {
			const result = await this.handleOpenOptional(c, regKey, code)
			type = result?.type
			regKeyId = result?.regKeyId
		}

		const accountRow = await accountService.selectByEmailIncludeDel(c, email);

		if (accountRow && accountRow.isDel === isDel.DELETE) {
			throw new BizError(t('isDelUser'));
		}

		if (accountRow) {
			throw new BizError(t('isRegAccount'));
		}

		let defType = null

		if (!type) {
			const roleRow = await roleService.selectDefaultRole(c);
			defType = roleRow.roleId
		}


		const roleRow = await roleService.selectById(c, type || defType);

		if(!roleService.hasAvailDomainPerm(roleRow.availDomain, email)) {

			if (type) {
				throw new BizError(t('noDomainPermRegKey'),403)
			}

			if (defType) {
				throw new BizError(t('noDomainPermReg'),403)
			}

		}

		let regVerifyOpen = false

		if (registerVerify === settingConst.registerVerify.OPEN) {
			regVerifyOpen = true
			await turnstileService.verify(c,token)
		}

		if (registerVerify === settingConst.registerVerify.COUNT) {
			regVerifyOpen = await verifyRecordService.isOpenRegVerify(c, regVerifyCount);
			if (regVerifyOpen) {
				await turnstileService.verify(c,token)
			}
		}

		const { salt, hash } = await saltHashUtils.hashPassword(password);

		const userId = await userService.insert(c, { email, regKeyId,password: hash, salt, type: type || defType });

		await accountService.insert(c, { userId: userId, email, name: emailUtils.getName(email) });

		await userService.updateUserInfo(c, userId, true);

		// 建号成功才计数，与上面的 assertNotLocked 配成一对固定窗口限速
		await limitUtils.recordFail(c, 'register:ip', registerIp);

		securityLog.write('user_registered', {
			email,
			userId,
			ip: registerIp,
			oauth: !!oauth
		});

		if (regKey !== settingConst.regKey.CLOSE && type) {
			await regKeyService.reduceCount(c, code, 1);
		}

		if (registerVerify === settingConst.registerVerify.COUNT && !regVerifyOpen) {
			const row = await verifyRecordService.increaseRegCount(c);
			return {regVerifyOpen: row.count >= regVerifyCount}
		}

		return {regVerifyOpen}

	},

	async registerVerify() {

	},

	async handleOpenRegKey(c, regKey, code) {

		if (!code) {
			throw new BizError(t('emptyRegKey'));
		}

		const regKeyRow = await regKeyService.selectByCode(c, code);

		if (!regKeyRow) {
			throw new BizError(t('notExistRegKey'));
		}

		if (regKeyRow.count <= 0) {
			throw new BizError(t('noRegKeyCount'));
		}

		const today = toUtc().tz('Asia/Shanghai').startOf('day')
		const expireTime = toUtc(regKeyRow.expireTime).tz('Asia/Shanghai').startOf('day');

		if (expireTime.isBefore(today)) {
			throw new BizError(t('regKeyExpire'));
		}

		return { type: regKeyRow.roleId, regKeyId: regKeyRow.regKeyId };
	},

	async handleOpenOptional(c, regKey, code) {

		if (!code) {
			return null
		}

		const regKeyRow = await regKeyService.selectByCode(c, code);

		if (!regKeyRow) {
			return null
		}

		const today = toUtc().tz('Asia/Shanghai').startOf('day')
		const expireTime = toUtc(regKeyRow.expireTime).tz('Asia/Shanghai').startOf('day');

		if (regKeyRow.count <= 0 || expireTime.isBefore(today)) {
			return null
		}

		return { type: regKeyRow.roleId, regKeyId: regKeyRow.regKeyId };
	},

	async login(c, params, noVerifyPwd = false) {

		let { email, password, token } = params;

		// 应用层加密的密码：前端用服务端下发的公钥加密过，这里还原成明文再走原有校验。
		// 必须是第一步 —— 放在"密码为空"判断之前，否则密文会被当成普通字符串，
		// 而放在哈希校验之后则完全没意义。
		// 未加密时（没配私钥，或旧版前端）原样使用，保证向后兼容。
		if (eciesUtils.isEncrypted(password)) {

			const plain = await eciesUtils.decrypt(c, password);

			// 解密失败通常意味着前端缓存了旧的公钥，让用户刷新重试即可
			if (plain === null) {
				throw new BizError(t('pwdDecryptFail'));
			}

			password = plain;
		}

		if ((!email || !password) && !noVerifyPwd) {
			throw new BizError(t('emailAndPwdEmpty'));
		}

		// 防暴力破解:按 账号 与 IP 双维度计数,命中锁定直接拒绝
		// 账号计数键统一小写去空格,避免改大小写绕过(邮箱查询本身不区分大小写)
		const ip = reqUtils.getIp(c);
		const limitEmail = String(email || '').trim().toLowerCase();

		if (!noVerifyPwd) {
			await limitUtils.assertNotLocked(c, 'login:email', limitEmail);
			await limitUtils.assertNotLocked(c, 'login:ip', ip);

			// 密码爆破防护的第二道闸：同一账号在窗口内连续失败到阈值后，
			// 登录必须带人机验证通过后的 token。
			//
			// 和上面的"锁定"是互补关系：锁定是硬拒绝（10 次/15 分钟），
			// 会误伤连续记错密码的正常用户；人机验证只是加一道门槛，
			// 正常用户点一下就能继续，脚本则被挡住。
			if (await limitUtils.getCount(c, 'login:email', limitEmail) >= LOGIN_CAPTCHA_THRESHOLD) {

				// 没带 token 时用独立状态码 430 告诉前端「该弹验证码了」，
				// 前端据此把控件渲染出来并重新提交。
				if (!token) {
					throw new BizError(t('emptyBotToken'), 430);
				}

				await turnstileService.verify(c, token);
			}
		}

		let userRow;

		try {

			userRow = await userService.selectByEmailIncludeDel(c, email);

			if (!userRow) {
				throw new BizError(t('notExistUser'));
			}

			if(userRow.isDel === isDel.DELETE) {
				throw new BizError(t('isDelUser'));
			}

			if(userRow.status === userConst.status.BAN) {
				throw new BizError(t('isBanUser'));
			}

			if (!await cryptoUtils.verifyPassword(password, userRow.salt, userRow.password) && !noVerifyPwd) {
				throw new BizError(t('IncorrectPwd'));
			}

		} catch (e) {

			// 登录失败累加计数(含账号不存在/被禁用,避免被用于账号枚举探测)
			if (!noVerifyPwd) {
				await limitUtils.recordFail(c, 'login:email', limitEmail);
				await limitUtils.recordFail(c, 'login:ip', ip);
				// 失败原因只记 code，不记 message —— message 会区分「用户不存在」和
				// 「密码错误」，而这两个恰恰是账号枚举要的信息。日志给管理员看，
				// 但也别让日志本身成为一份枚举字典。
				securityLog.write('login_failed', { email: limitEmail, ip, code: e?.code });
			}

			throw e;
		}

		if (!noVerifyPwd) {
			await limitUtils.clear(c, 'login:email', limitEmail);
			await limitUtils.clear(c, 'login:ip', ip);
			securityLog.write('login_success', { email: userRow.email, ip, userId: userRow.userId });
			// 旧版SHA-256哈希校验通过后惰性升级为PBKDF2
			await this.upgradePasswordIfLegacy(c, userRow, password);
		}

		const uuid = uuidv4();
		const jwt = await JwtUtils.generateToken(c,{ userId: userRow.userId, token: uuid });

		let authInfo = await c.env.kv.get(KvConst.AUTH_INFO + userRow.userId, { type: 'json' });

		if (authInfo && (authInfo.user.email === userRow.email)) {

			if (authInfo.tokens.length > 10) {
				authInfo.tokens.shift();
			}

			authInfo.tokens.push(uuid);

		} else {

			authInfo = {
				tokens: [],
				user: userRow,
				refreshTime: dayjs().toISOString()
			};

			authInfo.tokens.push(uuid);

		}

		await userService.updateUserInfo(c, userRow.userId);

		await c.env.kv.put(KvConst.AUTH_INFO + userRow.userId, JSON.stringify(authInfo), { expirationTtl: constant.TOKEN_EXPIRE });
		return jwt;
	},

	// 旧版单轮SHA-256哈希在校验通过后惰性升级为PBKDF2,升级失败不影响本次登录
	async upgradePasswordIfLegacy(c, userRow, password) {

		if (!cryptoUtils.isLegacyHash(userRow.password)) {
			return;
		}

		try {
			await userService.resetPassword(c, { password }, userRow.userId);
		} catch (e) {
			console.error('密码哈希升级失败:', e.message);
		}
	},

	async logout(c, userId) {
		const token =userContext.getToken(c);
		const authInfo = await c.env.kv.get(KvConst.AUTH_INFO + userId, { type: 'json' });

		// 会话信息缺失时直接返回,避免 authInfo.tokens 抛 TypeError
		if (!authInfo || !Array.isArray(authInfo.tokens)) {
			return;
		}

		const index = authInfo.tokens.findIndex(item => item === token);

		// index 为 -1 时 splice(-1, 1) 会误删最后一个会话,必须提前返回
		if (index === -1) {
			return;
		}

		authInfo.tokens.splice(index, 1);
		await c.env.kv.put(KvConst.AUTH_INFO + userId, JSON.stringify(authInfo), { expirationTtl: constant.TOKEN_EXPIRE });
	}

};

export default loginService;
