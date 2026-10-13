const { getSession } = require('../services/sessions');

function readCookie(req, name) {
  const header = req.headers.cookie || '';

  for (const item of header.split(';')) {
    const index = item.indexOf('=');

    if (index < 0) continue;

    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();

    if (key === name) {
      try {
        return decodeURIComponent(value);
      } catch {
        return null;
      }
    }
  }

  return null;
}

function createAuthMiddleware(type) {
  return async (req, res, next) => {
    try {
      const cookieName = type === 'admin'
        ? 'silent_admin_sid'
        : 'silent_customer_sid';

      const token = readCookie(req, cookieName);
      const session = await getSession(type, token);

      if (!session) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required.'
        });
      }

      req.auth = {
        id: session.id,
        type
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  customerAuth: createAuthMiddleware('customer'),
  adminAuth: createAuthMiddleware('admin'),
  readCookie
};
