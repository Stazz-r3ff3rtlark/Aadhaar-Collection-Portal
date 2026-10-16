'use strict';

const express = require('express');
const { defineRoute } = require('../http/route');
const { clearSessionCookie } = require('../http/session');
const { toIstSql } = require('../lib/time');
const auth = require('./auth-service');

function authRoutes() {
  const router = express.Router();

  defineRoute(router, 'post', '/otp/request', { auth: 'public', audit: 'auth.otp.request' },
    (ctx) => auth.requestCode(ctx, ctx.body.email, 'login'));

  defineRoute(router, 'post', '/otp/verify', { auth: 'public', audit: 'auth.login.otp' },
    (ctx) => auth.signInWithCode(ctx, ctx.body.email, ctx.body.code));

  defineRoute(router, 'post', '/password/login', { auth: 'public', audit: 'auth.login.password' },
    (ctx) => auth.signInWithPassword(ctx, ctx.body.email, ctx.body.password));

  defineRoute(router, 'post', '/password/reset/request', { auth: 'public', audit: 'auth.password_reset.request' },
    (ctx) => auth.requestCode(ctx, ctx.body.email, 'password_reset'));

  defineRoute(router, 'post', '/password/reset/confirm', { auth: 'public', audit: 'auth.password_reset.confirm' },
    (ctx) => auth.resetPassword(ctx, ctx.body.email, ctx.body.code, ctx.body.newPassword));

  defineRoute(router, 'post', '/logout', { auth: 'user', audit: 'auth.logout' }, async (ctx) => {
    await ctx.tx.sessions.update(ctx.session.id, {
      revokedAt: toIstSql(ctx.deps.clock.now()),
      revokedReason: 'logout',
    });
    ctx.audit.entityType = 'session';
    ctx.audit.entityId = ctx.session.id;
    clearSessionCookie(ctx);
    return { status: 204 };
  });

  defineRoute(router, 'get', '/me', { auth: 'user', audit: 'auth.session.read' }, async (ctx) => {
    ctx.audit.entityType = 'user';
    ctx.audit.entityId = ctx.user.id;
    return { body: { user: auth.publicUser(ctx.user) } };
  });

  return router;
}

module.exports = { authRoutes };
