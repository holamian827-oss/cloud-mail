import role from '../entity/role';
import orm from '../entity/orm';
import { eq, asc, inArray, and } from 'drizzle-orm';
import BizError from '../error/biz-error';
import rolePerm from '../entity/role-perm';
import perm from '../entity/perm';
import { permConst, roleConst } from '../const/entity-const';
import user from '../entity/user';
import verifyUtils from '../utils/verify-utils';
import { t } from '../i18n/i18n.js';
import emailUtils from '../utils/email-utils';
import permService from './perm-service';
import userContext from '../security/user-context';

// 「特权权限」清单：这些权限点让持有者能影响**其他用户**或**系统配置**。
//
// 提权防护只在这一组上做子集判断，**刻意不做全量权限比较** ——
// 普通用户角色带着 email:send / account:delete 这类「使用型」权限，
// 而管理型角色通常没有这些，全量比较会把「建一个普通用户」这种完全正常的
// 操作也判成提权而挡掉。要挡的是「把管理能力授出去」，不是「把邮箱功能授出去」。
const PRIVILEGE_PERM_KEYS = [
	'user:add',
	'user:set-type',
	'user:set-status',
	'user:set-pwd',
	'user:delete',
	'user:reset-send',
	'role:add',
	'role:set',
	'role:delete',
	'setting:set',
	'reg-key:add',
	'reg-key:delete',
	'all-email:delete'
];

const roleService = {

	async add(c, params, userId) {

		let { name, permIds, banEmail, availDomain } = params;

		if (!name) {
			throw new BizError(t('emptyRoleName'));
		}

		let roleRow = await orm(c).select().from(role).where(eq(role.name, name)).get();

		const notEmailIndex = banEmail.findIndex(item => (!verifyUtils.isEmail(item) && !verifyUtils.isDomain(item)) && item !== "*");

		if (notEmailIndex > -1) {
			throw new BizError(t('notEmail'));
		}

		banEmail = banEmail.join(',');

		availDomain = availDomain.join(',');

		roleRow = await orm(c).insert(role).values({...params, banEmail, availDomain, userId}).returning().get();

		if (permIds.length === 0) {
			return;
		}

		const rolePermList = permIds.map(permId => ({ permId, roleId: roleRow.roleId }));

		await orm(c).insert(rolePerm).values(rolePermList).run();


	},

	async roleList(c) {

		const roleList = await orm(c).select().from(role).orderBy(asc(role.sort)).all();
		const permList = await orm(c).select({ permId: perm.permId, roleId: rolePerm.roleId }).from(rolePerm)
			.leftJoin(perm, eq(perm.permId, rolePerm.permId))
			.where(eq(perm.type, permConst.type.BUTTON)).all();

		roleList.forEach(role => {
			role.banEmail = role.banEmail.split(",").filter(item => item !== "");
			role.availDomain = role.availDomain.split(",").filter(item => item !== "");
			role.permIds = permList.filter(perm => perm.roleId === role.roleId).map(perm => perm.permId);
		});

		return roleList;
	},

	/**
	 * 提权防护：操作者不能交出「自己没有的特权权限」。
	 *
	 * 为什么必须挡：/user/add、/user/setType、/role/set、/regKey/add 四条路都能
	 * 把角色发出去或把权限灌进角色。只要把其中任意一个权限授给非超管角色，
	 * 那个角色就能给自己套上更高的权限，一步提权。规则只有一句：
	 * 不能授予自己没有的特权权限。
	 */
	async assertCanGrantKeys(c, permKeys) {

		const operator = userContext.getUser(c);

		// 超管不受限（security.js 判定超管用的也是 email === c.env.admin）
		if (operator?.email === c.env.admin) {
			return;
		}

		const targetPrivileges = (permKeys || []).filter(key => PRIVILEGE_PERM_KEYS.includes(key));

		if (targetPrivileges.length === 0) {
			return;
		}

		const mine = await permService.userPermKeys(c, operator?.userId);

		// 通配表示不受限（loginUserInfo 会给超管邮箱发 '*'）
		if (mine.includes('*')) {
			return;
		}

		if (targetPrivileges.some(key => !mine.includes(key))) {
			throw new BizError(t('cannotGrantHigherRole'), 403);
		}
	},

	/** 按目标角色的权限做一次提权检查（用于 addUser / setType / 签发注册码） */
	async assertCanAssignRole(c, roleId) {
		const target = await permService.rolePermKeys(c, roleId);
		await this.assertCanGrantKeys(c, target);
	},

	/** permId 列表 → permKey 列表 */
	async selectPermKeysByIds(c, permIds) {

		if (!permIds?.length) {
			return [];
		}

		const rows = await orm(c).select({ permKey: perm.permKey }).from(perm)
			.where(inArray(perm.permId, permIds)).all();

		return rows.map(row => row.permKey).filter(Boolean);
	},

	async setRole(c, params) {

		let { name, permIds, roleId, banEmail, availDomain } = params;

		if (!name) {
			throw new BizError(t('emptyRoleName'));
		}

		delete params.isDefault

		const notEmailIndex = banEmail.findIndex(item => (!verifyUtils.isEmail(item) && !verifyUtils.isDomain(item)) && item !== "*")

		if (notEmailIndex > -1) {
			throw new BizError(t('notEmail'));
		}

		banEmail = banEmail.join(',')

		availDomain = availDomain.join(',')

		// 提权防护：只能往角色里灌「自己已经持有」的特权权限。
		// 原来这里是无条件 DELETE role_perm 再按传入的 permIds 重插，没有任何校验 ——
		// 持 role:set 的人可以给自己的角色塞进 setting:set、user:add 等任意权限点，一步提权。
		await this.assertCanGrantKeys(c, await this.selectPermKeysByIds(c, permIds));

		await orm(c).update(role).set({...params, banEmail, availDomain}).where(eq(role.roleId, roleId)).run();
		await orm(c).delete(rolePerm).where(eq(rolePerm.roleId, roleId)).run();

		if (permIds.length > 0) {
			const rolePermList = permIds.map(permId => ({ permId, roleId: roleId }));
			await orm(c).insert(rolePerm).values(rolePermList).run();
		}

	},

	async delete(c, params) {

		const { roleId } = params;

		const roleRow = await orm(c).select().from(role).where(eq(role.roleId, roleId)).get();

		if (!roleRow) {
			throw new BizError(t('notExist'));
		}

		if (roleRow.isDefault) {
			throw new BizError(t('delDefRole'));
		}

		const defRoleRow = await orm(c).select().from(role).where(eq(role.isDefault, roleConst.isDefault.OPEN)).get();

		if (!defRoleRow) {
			throw new BizError(t('delDefRole'));
		}

		// 用户 type 迁移、角色权限删除、角色删除必须是原子的，用 batch（事务语义）避免部分失败留下不一致数据
		await c.env.db.batch([
			c.env.db.prepare(`UPDATE user SET type = ? WHERE type = ?`).bind(defRoleRow.roleId, roleId),
			c.env.db.prepare(`DELETE FROM role_perm WHERE role_id = ?`).bind(roleId),
			c.env.db.prepare(`DELETE FROM role WHERE role_id = ?`).bind(roleId)
		]);

	},

	roleSelectUse(c) {
		return orm(c).select({ name: role.name, roleId: role.roleId, isDefault: role.isDefault }).from(role).orderBy(asc(role.sort)).all();
	},

	async selectDefaultRole(c) {
		return await orm(c).select().from(role).where(eq(role.isDefault, roleConst.isDefault.OPEN)).get();
	},

	async setDefault(c, params) {
		const roleRow = await orm(c).select().from(role).where(eq(role.roleId, params.roleId)).get();
		if (!roleRow) {
			throw new BizError(t('roleNotExist'));
		}
		await orm(c).update(role).set({ isDefault: 0 }).run();
		await orm(c).update(role).set({ isDefault: 1 }).where(eq(role.roleId, params.roleId)).run();
	},

	selectById(c, roleId) {
		return orm(c).select().from(role).where(eq(role.roleId, roleId)).get();
	},

	selectByIdsHasPermKey(c, types, permKey) {
		return orm(c).select({ roleId: role.roleId, sendType: role.sendType, sendCount: role.sendCount }).from(perm)
			.leftJoin(rolePerm, eq(perm.permId, rolePerm.permId))
			.leftJoin(role, eq(role.roleId, rolePerm.roleId))
			.where(and(eq(perm.permKey, permKey), inArray(role.roleId, types))).all();
	},

	selectByIdsAndSendType(c, permKey, sendType) {
		return orm(c).select({ roleId: role.roleId }).from(perm)
			.leftJoin(rolePerm, eq(perm.permId, rolePerm.permId))
			.leftJoin(role, eq(role.roleId, rolePerm.roleId))
			.where(and(eq(perm.permKey, permKey), eq(role.sendType, sendType))).all();
	},

	selectByUserId(c, userId) {
		return orm(c).select(role).from(user).leftJoin(role, eq(role.roleId, user.type)).where(eq(user.userId, userId)).get();
	},

	hasAvailDomainPerm(availDomain, email) {

		availDomain = availDomain.split(',').filter(item => item !== '');

		if (availDomain.length === 0) {
			return true
		}

		const availIndex = availDomain.findIndex(item => {
			const domain = emailUtils.getDomain(email.toLowerCase());
			const availDomainItem = item.toLowerCase();
			return domain === availDomainItem
		})

		return availIndex > -1
	},

	selectByName(c, roleName) {
		return orm(c).select().from(role).where(eq(role.name, roleName)).get();
	},

	async selectByUserIds(c, userIds) {

		if (!userIds || userIds.length === 0) {
			return [];
		}

		// in 查询受 D1 100 个绑定参数限制，按每批 90 个 id 分片查询后合并
		const batchSize = 90;
		const result = [];

		for (let i = 0; i < userIds.length; i += batchSize) {
			const rows = await orm(c).select({ ...role, userId: user.userId }).from(user)
				.leftJoin(role, eq(role.roleId, user.type))
				.where(inArray(user.userId, userIds.slice(i, i + batchSize))).all();
			result.push(...rows);
		}

		return result;

	},

	isBanEmail(banEmail, fromEmail) {

		banEmail = banEmail.split(',').filter(item => item !== '');

		if (banEmail.includes('*')) {
			return true;
		}

		for (const item of banEmail) {

			if (verifyUtils.isDomain(item)) {

				const banDomain = item.toLowerCase();
				const receiveDomain = emailUtils.getDomain(fromEmail.toLowerCase());

				if (banDomain === receiveDomain) {
					return true;
				}

			} else {

				if (item.toLowerCase() === fromEmail.toLowerCase()) {

					return true;

				}

			}

		}

		return false;
	}
};

export default roleService;
