// Централизованный флаг доверия заголовкам reverse-proxy (X-Forwarded-*).
// Используется и для определения HTTPS (Secure-флаг cookie в session.js),
// и для получения реального IP клиента (rate limiting в rateLimit.js).
// Оба места должны разделять один и тот же флаг — иначе прокси считается
// доверенным в одном месте и нет в другом, что открывает дыру в защите.
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

module.exports = { TRUST_PROXY };
