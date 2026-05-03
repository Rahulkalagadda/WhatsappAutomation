/**
 * Async sleep for a fixed duration (milliseconds).
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Random integer in [min, max] inclusive.
 * @param {number} min
 * @param {number} max
 */
function randomIntInclusive(min, max) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

/**
 * Random delay between minMs and maxMs (inclusive), then resolves.
 * @param {number} minMs
 * @param {number} maxMs
 * @returns {Promise<void>}
 */
async function randomDelay(minMs, maxMs) {
  const ms = randomIntInclusive(minMs, maxMs);
  await sleep(ms);
}

module.exports = {
  sleep,
  randomIntInclusive,
  randomDelay,
};
