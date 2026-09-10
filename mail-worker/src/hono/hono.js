import { Hono } from 'hono';
const app = new Hono();

import result from '../model/result';
import { cors } from 'hono/cors';

// CORS 收紧到实际使用的方法与请求头,不使用全通配
app.use('*', cors({
	origin: '*',
	allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
	allowHeaders: ['Content-Type', 'Authorization'],
	maxAge: 600
}));

app.onError((err, c) => {
	if (err.name === 'BizError') {
		console.log(err.message);
	} else {
		console.error(err);
	}

	if (err.message === `Cannot read properties of undefined (reading 'get')`) {
		return c.json(result.fail('KV数据库未绑定<br/>KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'put')`) {
		return c.json(result.fail('KV数据库未绑定<br/>KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'prepare')`) {
		return c.json(result.fail('D1数据库未绑定<br/>D1 database not bound',502));
	}

	if (err.message?.includes('D1_ERROR: no such column')) {
		return c.json(result.fail('请按照文档更新数据库<br/>Please update the database as documented',502));
	}

	// 业务错误保留原始提示;非预期错误(D1/SQL等)不下发内部细节,仅记录服务端日志
	if (err.name === 'BizError') {
		return c.json(result.fail(err.message, err.code));
	}

	return c.json(result.fail('服务器内部错误,请稍后重试 Server internal error', 500));
});

export default app;


