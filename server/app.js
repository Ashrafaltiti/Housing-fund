'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const { rateLimit } = require('express-rate-limit');
const { HttpError } = require('./fund');

/**
 * @param {object} deps
 * @param {import('./fund').FundService} deps.fund
 * @param {import('firebase-admin/auth').Auth} deps.auth
 * @param {object} deps.clientConfig  public Firebase web config (+ optional emulator hosts)
 */
function createApp({ fund, auth, clientConfig, rateLimitPerMinute = 60 }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render terminates TLS in front of us

  const authDomain = clientConfig.firebase?.authDomain;
  const emulatorOrigins = clientConfig.emulators
    ? [`http://${clientConfig.emulators.auth}`, `http://${clientConfig.emulators.firestore}`, `ws://${clientConfig.emulators.firestore}`]
    : [];
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://apis.google.com'],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'https://*.googleusercontent.com'],
          connectSrc: [
            "'self'",
            'https://*.googleapis.com',
            'https://securetoken.googleapis.com',
            'https://identitytoolkit.googleapis.com',
            'https://firestore.googleapis.com',
            ...emulatorOrigins,
          ],
          frameSrc: authDomain ? [`https://${authDomain}`, 'https://accounts.google.com'] : ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: clientConfig.emulators ? null : [],
        },
      },
      // Google sign-in uses a popup that must be able to talk back to this window.
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    }),
  );

  app.use(compression());

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.get('/api/config', (_req, res) => {
    res.set('Cache-Control', 'no-store').json(clientConfig);
  });

  const api = express.Router();
  api.use(
    rateLimit({
      windowMs: 60_000,
      limit: rateLimitPerMinute,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: { code: 'rate-limited', message: 'طلبات كثيرة، استنى شوي وحاول مرة ثانية' } },
    }),
  );
  api.use(express.json({ limit: '10kb' }));

  const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const asyncMiddleware = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then(() => next(), next);

  // Verify the Firebase ID token (including revocation) on every API call.
  const authMiddleware = asyncMiddleware(async (req) => {
    const match = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (!match) throw new HttpError(401, 'unauthenticated', 'لازم تسجل الدخول');
    let decoded;
    try {
      decoded = await auth.verifyIdToken(match[1], true);
    } catch {
      throw new HttpError(401, 'unauthenticated', 'انتهت الجلسة، سجل الدخول مرة ثانية');
    }
    req.user = { uid: decoded.uid, email: decoded.email, emailVerified: decoded.email_verified === true, name: decoded.name };
  });

  // Resolves the member doc; every money endpoint requires an active member.
  const memberMiddleware = asyncMiddleware(async (req) => {
    req.member = await fund.ensureMember(req.user);
  });
  const requireAdmin = (req, _res, next) =>
    next(req.member?.role === 'admin' ? undefined : new HttpError(403, 'forbidden', 'هذه العملية للمسؤول فقط'));

  api.post('/session', authMiddleware, memberMiddleware, (req, res) => res.json({ member: req.member }));

  api.patch('/me', authMiddleware, memberMiddleware, asyncRoute(async (req, res) => {
    res.json({ member: await fund.updateProfile(req.member, req.body) });
  }));

  api.post('/transactions', authMiddleware, memberMiddleware, asyncRoute(async (req, res) => {
    const result = await fund.addTransaction(req.member, req.body);
    res.status(result.duplicate ? 200 : 201).json(result);
  }));

  api.post('/transactions/:id/reverse', authMiddleware, memberMiddleware, asyncRoute(async (req, res) => {
    res.status(201).json(await fund.reverseTransaction(req.member, req.params.id, req.body));
  }));

  api.post('/admin/members', authMiddleware, memberMiddleware, requireAdmin, asyncRoute(async (req, res) => {
    res.status(201).json(await fund.inviteMember(req.member, req.body));
  }));

  api.delete('/admin/members/:email', authMiddleware, memberMiddleware, requireAdmin, asyncRoute(async (req, res) => {
    res.json(await fund.removeMember(req.member, req.params.email));
  }));

  api.use((_req, _res, next) => next(new HttpError(404, 'not-found', 'غير موجود')));
  app.use('/api', api);

  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], maxAge: '1h', index: 'index.html' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(400).json({ error: { code: 'bad-request', message: 'طلب غير صالح' } });
    }
    // Only our own HttpError/ValidationError messages are shown to users; anything else is a 500.
    if (!err.expose) {
      console.error(err);
      return res.status(500).json({ error: { code: 'internal', message: 'صار خطأ في الخادم، حاول مرة ثانية' } });
    }
    if (err.status === 503) res.set('Retry-After', '1');
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
  });

  return app;
}

module.exports = { createApp };
