const { TRUST_PROXY } = require('./config');

/**
 * Простая защита от ботов/брутфорса (rate limit по IP + действию).
 * Используется маршрутами auth (login/register/check-username).
 */

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // окно, через которое счётчик попыток сбрасывается
const RATE_LIMIT_ENTRY_TTL_MS = 2 * 60 * 60 * 1000; // возраст записи, после которого её можно удалить
const RATE_LIMIT_CLEANUP_PROBABILITY = 0.03; // шанс запуска очистки старых записей на каждый вызов

const rateLimits = new Map(); // key -> { attempts, first, last }

function getClientIP(req) {
  // X-Forwarded-For подделывается клиентом сколь угодно легко — доверяем ему
  // только когда оператор подтвердил (TRUST_PROXY=true), что сервер стоит за
  // reverse-proxy, который сам устанавливает этот заголовок. Иначе rate-limit
  // и IP allowlist можно было бы обойти одним заголовком в запросе.
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function isRateLimited(ip, action = 'register', maxAttempts = 5, minIntervalMs = 30000) {
  const now = Date.now();
  const key = `${ip}:${action}`;
  let entry = rateLimits.get(key);

  if (!entry) {
    entry = { attempts: 0, first: now, last: 0 };
    rateLimits.set(key, entry);
  }

  if (now - entry.first > RATE_LIMIT_WINDOW_MS) {
    entry.attempts = 0;
    entry.first = now;
  }

  // Слишком частые попытки
  if (now - entry.last < minIntervalMs) {
    return { limited: true, reason: 'too_fast' };
  }

  if (entry.attempts >= maxAttempts) {
    return { limited: true, reason: 'max_attempts' };
  }

  entry.attempts += 1;
  entry.last = now;

  // Редкая очистка
  if (Math.random() < RATE_LIMIT_CLEANUP_PROBABILITY) {
    for (const [k, e] of rateLimits) {
      if (now - e.first > RATE_LIMIT_ENTRY_TTL_MS) rateLimits.delete(k);
    }
  }

  return { limited: false };
}

module.exports = { getClientIP, isRateLimited };
