// Logs every request before handing it on.
module.exports = class RequestLogger extends Middleware {
  handle(req, next) {
    return next(req);
  }
};
