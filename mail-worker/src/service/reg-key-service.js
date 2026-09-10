import orm from '../entity/orm';
import regKey from '../entity/reg-key';
import { inArray, like, eq, desc, sql, or, and, gt } from 'drizzle-orm';
import roleService from './role-service';
import BizError from '../error/biz-error';
import { formatDetailDate, toUtc } from '../utils/date-uitil';
import userService from './user-service';
import { t } from '../i18n/i18n.js';

const regKeyService = {

	async add(c, params, userId) {

		let {code,roleId,count,expireTime} = params;

		if (!code) {
			throw new BizError(t('emptyRegKey'));
		}

		if (!count) {
			throw new BizError(t('emptyRegKey'));
		}

		if (!expireTime) {
			throw new BizError(t('emptyRegKeyExpire'));
		}

		const regKeyRow = await orm(c).select().from(regKey).where(eq(regKey.code, code)).get();

		if (regKeyRow) {
			throw new BizError(t('isExistRegKye'));
		}

		const roleRow = await roleService.selectById(c, roleId);
		if (!roleRow) {
			throw new BizError(t('roleNotExist'));
		}

		expireTime = formatDetailDate(expireTime)

		await orm(c).insert(regKey).values({code,roleId,count,userId,expireTime}).run();
	},

	async delete(c, params) {
		let {regKeyIds} = params;
		regKeyIds = regKeyIds.split(',').map(id => Number(id));

		// in 查询受 D1 100 个绑定参数限制，按每批 90 个 id 分片执行
		const batchSize = 90;

		for (let i = 0; i < regKeyIds.length; i += batchSize) {
			await orm(c).delete(regKey).where(inArray(regKey.regKeyId, regKeyIds.slice(i, i + batchSize))).run();
		}
	},

	async clearNotUse(c) {
		// 必须和 handleOpenRegKey / list() 同一口径：注册码在「到期日的上海自然日」
		// 内都还算有效，所以只在到期日**次日**才清理。
		// expire_time 存的是 UTC 裸字符串（上海 D 日 00:00 → UTC D-1 日 16:00），
		// '+8 hours' 把它还原成上海墙上时间，再与「上海今天 00:00」比较。
		// 注意不能用当前时刻直接比 datetime(expire_time)：存的是当天 00:00，
		// 一过零点就会被判为过期，注册码会在到期日当天被删掉，
		// 而注册流程仍然放行 —— 管理员点一次「清理未使用」就会误删还能用的码。
		let now = formatDetailDate(toUtc().tz('Asia/Shanghai').startOf('day'))
		await orm(c).delete(regKey).where(or(eq(regKey.count, 0), sql`datetime(${regKey.expireTime}, '+8 hours') < datetime(${now})`)).run();
	},

	selectByCode(c, code) {
		return orm(c).select().from(regKey).where(eq(regKey.code, code)).get();
	},

	async list(c, params) {

		const {code} = params
		let query = orm(c).select().from(regKey)

		if (code) {
			query = query.where(like(regKey.code, `${code}%`))
		}

		const regKeyList = await query.orderBy(desc(regKey.regKeyId)).all();
		const roleList = await roleService.roleSelectUse(c);

		const today = toUtc().tz('Asia/Shanghai').startOf('day')

		regKeyList.forEach(regKeyRow => {

			const index = roleList.findIndex(roleRow => roleRow.roleId === regKeyRow.roleId)
			regKeyRow.roleName = index > -1 ? roleList[index].name : ''

			const expireTime = toUtc(regKeyRow.expireTime).tz('Asia/Shanghai').startOf('day');

			if (expireTime.isBefore(today)) {
				regKeyRow.expireTime = null
			}
		})

		return regKeyList;
	},

	async reduceCount(c, code, count) {
		// 条件更新：仅当剩余次数 > 0 时才扣减，避免并发注册把次数扣成负数
		const result = await orm(c).update(regKey).set({
			count: sql`${regKey.count}
	  -
	  ${count}`
		}).where(and(eq(regKey.code, code), gt(regKey.count, 0))).run();
		return result;
	},

	async history(c, params) {
		const { regKeyId } = params;
		return userService.listByRegKeyId(c, regKeyId);
	}
}

export default regKeyService;
