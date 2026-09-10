import BizError from '../error/biz-error';
import orm from '../entity/orm';
import { v4 as uuidv4 } from 'uuid';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import saltHashUtils from '../utils/crypto-utils';
import cryptoUtils from '../utils/crypto-utils';
import emailUtils from '../utils/email-utils';
import domainUtils from '../utils/domain-uitls';
import roleService from './role-service';
import verifyUtils from '../utils/verify-utils';
import { t } from '../i18n/i18n';
import reqUtils from '../utils/req-utils';
import dayjs from 'dayjs';
import { isDel, roleConst, settingConst } from '../const/entity-const';
import email from '../entity/email';
import userService from './user-service';
import settingService from './setting-service';
import KvConst from '../const/kv-const';
import limitUtils from '../utils/limit-utils';
import securityLog from '../utils/security-log';

// 公开建号接口单次请求的批量上限。
// 原来这里没有上限：一个请求就能提交成千上万条，既可能撑爆 128MB 内存，
// 也会把 D1 的单次 batch 撑到失败（每条用户还要额外配一条 account 语句）。
const PUBLIC_ADD_USER_MAX = 200;

const publicService = {

	async emailList(c, params) {

		let { toEmail, content, subject, sendName, sendEmail, timeSort, num, size, type , isDel } = params

		const query = orm(c).select({
				emailId: email.emailId,
				sendEmail: email.sendEmail,
				sendName: email.name,
				subject: email.subject,
				toEmail: email.toEmail,
				toName: email.toName,
				type: email.type,
				createTime: email.createTime,
				content: email.content,
				text: email.text,
				isDel: email.isDel,
		}).from(email)

		if (!size) {
			size = 20
		}

		if (!num) {
			num = 1
		}

		size = Number(size);
		num = Number(num);

		num = (num - 1) * size;

		let conditions = []

		if (toEmail) {
			conditions.push(sql`${email.toEmail} COLLATE NOCASE LIKE ${toEmail}`)
		}

		if (sendEmail) {
			conditions.push(sql`${email.sendEmail} COLLATE NOCASE LIKE ${sendEmail}`)
		}

		if (sendName) {
			conditions.push(sql`${email.name} COLLATE NOCASE LIKE ${sendName}`)
		}

		if (subject) {
			conditions.push(sql`${email.subject} COLLATE NOCASE LIKE ${subject}`)
		}

		if (content) {
			conditions.push(sql`${email.content} COLLATE NOCASE LIKE ${content}`)
		}

		if (type || type === 0) {
			conditions.push(eq(email.type, type))
		}

		if (isDel || isDel === 0) {
			conditions.push(eq(email.isDel, isDel))
		}

		if (conditions.length === 1) {
			query.where(...conditions)
		} else if (conditions.length > 1) {
			query.where(and(...conditions))
		}

		if (timeSort === 'asc') {
			query.orderBy(asc(email.emailId));
		} else {
			query.orderBy(desc(email.emailId));
		}

		return query.limit(size).offset(num);

	},

	async addUser(c, params) {
		const { list } = params;

		if (!Array.isArray(list) || list.length === 0) return;

		if (list.length > PUBLIC_ADD_USER_MAX) {
			throw new BizError(t('tooManyAddUser', { msg: PUBLIC_ADD_USER_MAX }));
		}

		const { register, minEmailPrefix, emailPrefixFilter } = await settingService.query(c);

		// 注册关闭时，这条公开建号通道也必须一起关掉。
		// 原来它完全不看 register 开关 —— 只要 public token 泄露，
		// 管理员就算把注册关了也挡不住批量建号，是一条后门级通道。
		if (register === settingConst.register.CLOSE) {
			throw new BizError(t('disabledRegister'), 403);
		}

		for (const emailRow of list) {
			if (!verifyUtils.isEmail(emailRow.email)) {
				throw new BizError(t('notEmail'));
			}

			// 与 /register 同一条规则：不允许通过建号接口创建 `+` 别名。
			// 否则可以抢先注册 `别人+标签@域名` 来截收发给该别名的邮件。
			if (emailUtils.getName(emailRow.email).includes('+')) {
				throw new BizError(t('aliasNotAllowed'));
			}

			// 前缀策略必须和 /register、/account/add 一致，
			// 否则同一条策略在公开接口上形同虚设。
			if (emailUtils.getName(emailRow.email).length < minEmailPrefix) {
				throw new BizError(t('minEmailPrefix', { msg: minEmailPrefix }));
			}

			if (emailPrefixFilter.some(content => emailUtils.getName(emailRow.email).includes(content))) {
				throw new BizError(t('banEmailPrefix'));
			}

			if (!domainUtils.isAllowedEmailDomain(c, emailRow.email)) {
				throw new BizError(t('notEmailDomain'));
			}

			const { salt, hash } = await saltHashUtils.hashPassword(
				emailRow.password || cryptoUtils.genRandomPwd()
			);

			emailRow.salt = salt;
			emailRow.hash = hash;
		}


		const activeIp = reqUtils.getIp(c);
		const { os, browser, device } = reqUtils.getUserAgent(c);
		const activeTime = dayjs().format('YYYY-MM-DD HH:mm:ss');

		const roleList = await roleService.roleSelectUse(c);
		const defRole = roleList.find(roleRow => roleRow.isDefault === roleConst.isDefault.OPEN);

		const userList = [];

		if (!defRole) {
			throw new BizError(t('roleNotExist'));
		}

		for (const emailRow of list) {
			let { email, hash, salt, roleName } = emailRow;

			// 角色一律用默认角色，**不接受调用方指定**。
			// 原来 list[].roleName 命中哪个角色就把 type 设成哪个 ——
			// 持有 public token 的人可以直接指定管理员角色，等于 token 泄露即可提权。
			// 公开供给接口本就只该授予最小权限；确实需要指定角色的走管理端 /user/add。
			if (roleName && roleName !== defRole.name) {
				console.error(`[public/addUser] 已忽略调用方指定的 roleName="${roleName}"，统一使用默认角色`);
			}

			let type = defRole.roleId;

			// 使用参数化绑定,避免邮箱/UA/IP 等可控字段造成 SQL 注入
			const userSql = `INSERT INTO user (email, password, salt, type, os, browser, active_ip, create_ip, device, active_time, create_time)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

			const accountSql = `INSERT INTO account (email, name, user_id)
			VALUES (?, ?, 0);`;

			userList.push(c.env.db.prepare(userSql).bind(email, hash, salt, type, os, browser, activeIp, activeIp, device, activeTime, activeTime));
			userList.push(c.env.db.prepare(accountSql).bind(email, emailUtils.getName(email)));

		}

		userList.push(c.env.db.prepare(`UPDATE account SET user_id = (SELECT user_id FROM user WHERE user.email = account.email) WHERE user_id = 0;`))

		try {
			await c.env.db.batch(userList);
		} catch (e) {
			if(e.message.includes('SQLITE_CONSTRAINT')) {
				throw new BizError(t('emailExistDatabase'))
			} else {
				throw e
			}
		}

		securityLog.write('users_bulk_created', { count: list.length, ip: activeIp });

	},

	async genToken(c, params) {

		const ip = reqUtils.getIp(c);

		// 防暴力破解:该接口未鉴权,持续尝试会命中超管密码,按 IP 计数锁定
		await limitUtils.assertNotLocked(c, 'genToken:ip', ip);

		try {
			await this.verifyUser(c, params)
		} catch (e) {
			await limitUtils.recordFail(c, 'genToken:ip', ip);
			throw e;
		}

		await limitUtils.clear(c, 'genToken:ip', ip);

		const uuid = uuidv4();

		await c.env.kv.put(KvConst.PUBLIC_KEY, uuid);

		// 公开 token 等同于「批量建号 + 读全部邮件」的长期凭据，签发必须留痕。
		// 注意：这次写入会覆盖旧 token，既有集成会立刻失效，日志能帮上定位。
		securityLog.write('public_token_issued', { ip });

		return {token: uuid}
	},

	async verifyUser(c, params) {

		const { email, password } = params

		const userRow = await userService.selectByEmailIncludeDel(c, email);

		if (email !== c.env.admin) {
			throw new BizError(t('notAdmin'));
		}

		if (!userRow || userRow.isDel === isDel.DELETE) {
			throw new BizError(t('notExistUser'));
		}

		if (!await cryptoUtils.verifyPassword(password, userRow.salt, userRow.password)) {
			throw new BizError(t('IncorrectPwd'));
		}

		// 旧版哈希校验通过后惰性升级为PBKDF2,失败不影响本次校验
		if (cryptoUtils.isLegacyHash(userRow.password)) {
			try {
				await userService.resetPassword(c, { password }, userRow.userId);
			} catch (e) {
				console.error('密码哈希升级失败:', e.message);
			}
		}
	}

}

export default publicService
