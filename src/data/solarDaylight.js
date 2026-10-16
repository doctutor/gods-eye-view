// Personal fork: sun position, sunrise/sunset and solar time (NOAA algorithm).

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
/** Sunrise/sunset: the upper limb on the horizon, with standard refraction. */
export const SUNRISE_ELEVATION_DEG = -0.833;
/** Civil twilight ends when the sun is this far below the horizon. */
export const CIVIL_TWILIGHT_DEG = -6;

/**
 * Solar declination (degrees) and the equation of time (minutes) at an
 * instant, from NOAA's solar calculator (Meeus, low precision; ~1 minute).
 * @param {number} ms  Epoch milliseconds.
 */
export function solarParameters(ms) {
  const jd = ms / DAY_MS + 2440587.5;
  const t = (jd - 2451545) / 36525;
  const l0 =
    (((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360) + 360) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c =
    Math.sin(m * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const lambda = l0 + c - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 =
    23 +
    (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const declination =
    Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) / RAD;
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eqTime =
    4 *
    ((y * Math.sin(2 * l0 * RAD) -
      2 * e * Math.sin(m * RAD) +
      4 * e * y * Math.sin(m * RAD) * Math.cos(2 * l0 * RAD) -
      0.5 * y * y * Math.sin(4 * l0 * RAD) -
      1.25 * e * e * Math.sin(2 * m * RAD)) /
      RAD);
  return { declination, eqTime };
}

/** Minutes since UTC midnight. */
function utcMinutes(ms) {
  return (((ms % DAY_MS) + DAY_MS) % DAY_MS) / 60_000;
}

/**
 * Apparent (true) solar time at a longitude: 12:00 is the sun's transit.
 * @returns {{hours: number, minutes: number}}
 */
export function apparentSolarTime(ms, lon) {
  const { eqTime } = solarParameters(ms);
  const total = (((utcMinutes(ms) + eqTime + 4 * lon) % 1440) + 1440) % 1440;
  const rounded = Math.round(total) % 1440;
  return { hours: Math.floor(rounded / 60), minutes: rounded % 60 };
}

/**
 * The sun's elevation above the horizon (degrees, no refraction) and its hour
 * angle (negative before noon).
 */
export function sunPosition(ms, lat, lon) {
  const { declination, eqTime } = solarParameters(ms);
  const trueSolar =
    (((utcMinutes(ms) + eqTime + 4 * lon) % 1440) + 1440) % 1440;
  const hourAngle = trueSolar / 4 - 180;
  const cosZenith =
    Math.sin(lat * RAD) * Math.sin(declination * RAD) +
    Math.cos(lat * RAD) *
      Math.cos(declination * RAD) *
      Math.cos(hourAngle * RAD);
  const zenith = Math.acos(Math.max(-1, Math.min(1, cosZenith))) / RAD;
  return { elevation: 90 - zenith, hourAngle };
}

/**
 * 'day', 'dawn', 'dusk' or 'night' at a place and instant: civil twilight is
 * dawn before solar noon and dusk after it.
 */
export function daylightPhase(ms, lat, lon) {
  const { elevation, hourAngle } = sunPosition(ms, lat, lon);
  if (elevation > SUNRISE_ELEVATION_DEG) return 'day';
  if (elevation > CIVIL_TWILIGHT_DEG) return hourAngle < 0 ? 'dawn' : 'dusk';
  return 'night';
}

/** Sunrise or sunset (epoch ms) near a guess; null when the sun never crosses. */
function crossing(guessMs, lat, lon, sign) {
  let ms = guessMs;
  for (let i = 0; i < 3; i++) {
    const { declination, eqTime } = solarParameters(ms);
    const cosHa =
      Math.cos((90 - SUNRISE_ELEVATION_DEG) * RAD) /
        (Math.cos(lat * RAD) * Math.cos(declination * RAD)) -
      Math.tan(lat * RAD) * Math.tan(declination * RAD);
    if (cosHa > 1 || cosHa < -1) return null;
    const ha = Math.acos(cosHa) / RAD;
    const dayStart = Math.floor(ms / DAY_MS) * DAY_MS;
    const noonMin = 720 - 4 * lon - eqTime;
    let next = dayStart + (noonMin + sign * 4 * ha) * 60_000;
    // Stay on the same solar day as the guess.
    if (next - ms > DAY_MS / 2) next -= DAY_MS;
    if (ms - next > DAY_MS / 2) next += DAY_MS;
    ms = next;
  }
  return ms;
}

/**
 * Sunrise and sunset (epoch ms) on the local solar day that contains the
 * given UTC calendar date's local noon at `lon`. In polar day or night the
 * times are null and `polar` says which.
 * @param {number} year
 * @param {number} month  1–12
 * @param {number} day
 */
export function sunriseSunset(year, month, day, lat, lon) {
  const noon = Date.UTC(year, month - 1, day) + (720 - 4 * lon) * 60_000;
  const sunrise = crossing(noon - DAY_MS / 4, lat, lon, -1);
  const sunset = crossing(noon + DAY_MS / 4, lat, lon, 1);
  let polar = null;
  if (sunrise === null || sunset === null)
    polar =
      sunPosition(noon, lat, lon).elevation > SUNRISE_ELEVATION_DEG
        ? 'day'
        : 'night';
  return { sunrise, sunset, polar };
}
