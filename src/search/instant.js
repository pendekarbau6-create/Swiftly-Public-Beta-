'use strict';

/**
 * Instant answers: the small, fast answers Swiftly shows above the web
 * results — calculations, unit conversions, weather, definitions and times.
 *
 * Anything that needs the network is best-effort; the calculator and the unit
 * converter are computed locally so they always work, even offline.
 */

const { getJson } = require('./http');
const { evaluate } = require('./calculator');
const { cleanText } = require('./html');
const { LRUCache } = require('./cache');

const cache = new LRUCache({ max: 120, ttl: 30 * 60 * 1000 });

/* ------------------------------------------------------------------ units */

/** Each unit is expressed relative to the category's base unit. */
const UNITS = {
  // length — base: metre
  mm: { cat: 'length', factor: 0.001, name: 'millimetres' },
  cm: { cat: 'length', factor: 0.01, name: 'centimetres' },
  m: { cat: 'length', factor: 1, name: 'metres' },
  km: { cat: 'length', factor: 1000, name: 'kilometres' },
  in: { cat: 'length', factor: 0.0254, name: 'inches' },
  ft: { cat: 'length', factor: 0.3048, name: 'feet' },
  yd: { cat: 'length', factor: 0.9144, name: 'yards' },
  mi: { cat: 'length', factor: 1609.344, name: 'miles' },
  nmi: { cat: 'length', factor: 1852, name: 'nautical miles' },
  mil: { cat: 'length', factor: 0.0000254, name: 'mils' },

  // mass — base: kilogram
  mg: { cat: 'mass', factor: 1e-6, name: 'milligrams' },
  g: { cat: 'mass', factor: 0.001, name: 'grams' },
  kg: { cat: 'mass', factor: 1, name: 'kilograms' },
  t: { cat: 'mass', factor: 1000, name: 'tonnes' },
  oz: { cat: 'mass', factor: 0.028349523125, name: 'ounces' },
  lb: { cat: 'mass', factor: 0.45359237, name: 'pounds' },
  st: { cat: 'mass', factor: 6.35029318, name: 'stone' },

  // volume — base: litre
  ml: { cat: 'volume', factor: 0.001, name: 'millilitres' },
  l: { cat: 'volume', factor: 1, name: 'litres' },
  tsp: { cat: 'volume', factor: 0.00492892159375, name: 'teaspoons' },
  tbsp: { cat: 'volume', factor: 0.01478676478125, name: 'tablespoons' },
  floz: { cat: 'volume', factor: 0.0295735295625, name: 'fluid ounces' },
  pt: { cat: 'volume', factor: 0.473176473, name: 'pints' },
  qt: { cat: 'volume', factor: 0.946352946, name: 'quarts' },
  gal: { cat: 'volume', factor: 3.785411784, name: 'gallons' },
  cup: { cat: 'volume', factor: 0.2365882365, name: 'cups' },

  // data — base: byte
  b: { cat: 'data', factor: 1, name: 'bytes' },
  kb: { cat: 'data', factor: 1e3, name: 'kilobytes' },
  mb: { cat: 'data', factor: 1e6, name: 'megabytes' },
  gb: { cat: 'data', factor: 1e9, name: 'gigabytes' },
  tb: { cat: 'data', factor: 1e12, name: 'terabytes' },
  kib: { cat: 'data', factor: 1024, name: 'kibibytes' },
  mib: { cat: 'data', factor: 1024 ** 2, name: 'mebibytes' },
  gib: { cat: 'data', factor: 1024 ** 3, name: 'gibibytes' },
  tib: { cat: 'data', factor: 1024 ** 4, name: 'tebibytes' },

  // time — base: second
  s: { cat: 'time', factor: 1, name: 'seconds' },
  min: { cat: 'time', factor: 60, name: 'minutes' },
  h: { cat: 'time', factor: 3600, name: 'hours' },
  d: { cat: 'time', factor: 86400, name: 'days' },
  wk: { cat: 'time', factor: 604800, name: 'weeks' },
  yr: { cat: 'time', factor: 31557600, name: 'years' },

  // area — base: square metre
  m2: { cat: 'area', factor: 1, name: 'square metres' },
  km2: { cat: 'area', factor: 1e6, name: 'square kilometres' },
  cm2: { cat: 'area', factor: 1e-4, name: 'square centimetres' },
  ft2: { cat: 'area', factor: 0.09290304, name: 'square feet' },
  mi2: { cat: 'area', factor: 2589988.11, name: 'square miles' },
  acre: { cat: 'area', factor: 4046.8564224, name: 'acres' },
  ha: { cat: 'area', factor: 10000, name: 'hectares' },

  // speed — base: metre per second
  mps: { cat: 'speed', factor: 1, name: 'metres per second' },
  kph: { cat: 'speed', factor: 0.277777778, name: 'kilometres per hour' },
  mph: { cat: 'speed', factor: 0.44704, name: 'miles per hour' },
  knot: { cat: 'speed', factor: 0.514444444, name: 'knots' },
};

const UNIT_ALIASES = {
  metre: 'm', metres: 'm', meter: 'm', meters: 'm',
  kilometre: 'km', kilometres: 'km', kilometer: 'km', kilometers: 'km',
  centimetre: 'cm', centimetres: 'cm', centimeter: 'cm', centimeters: 'cm',
  millimetre: 'mm', millimetres: 'mm', millimeter: 'mm', millimeters: 'mm',
  inch: 'in', inches: 'in', '"': 'in',
  foot: 'ft', feet: 'ft', "'": 'ft',
  yard: 'yd', yards: 'yd',
  mile: 'mi', miles: 'mi',
  'nautical mile': 'nmi', 'nautical miles': 'nmi',
  gram: 'g', grams: 'g', gramme: 'g', grammes: 'g',
  kilogram: 'kg', kilograms: 'kg', kilo: 'kg', kilos: 'kg',
  tonne: 't', tonnes: 't', ton: 't', tons: 't',
  ounce: 'oz', ounces: 'oz',
  pound: 'lb', pounds: 'lb', lbs: 'lb',
  stone: 'st', stones: 'st',
  litre: 'l', litres: 'l', liter: 'l', liters: 'l',
  millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml',
  gallon: 'gal', gallons: 'gal',
  pint: 'pt', pints: 'pt',
  quart: 'qt', quarts: 'qt',
  cup: 'cup', cups: 'cup',
  tablespoon: 'tbsp', tablespoons: 'tbsp',
  teaspoon: 'tsp', teaspoons: 'tsp',
  byte: 'b', bytes: 'b',
  kilobyte: 'kb', kilobytes: 'kb',
  megabyte: 'mb', megabytes: 'mb',
  gigabyte: 'gb', gigabytes: 'gb',
  terabyte: 'tb', terabytes: 'tb',
  kibibyte: 'kib', kibibytes: 'kib',
  mebibyte: 'mib', mebibytes: 'mib',
  gibibyte: 'gib', gibibytes: 'gib',
  tebibyte: 'tib', tebibytes: 'tib',
  second: 's', seconds: 's', sec: 's', secs: 's',
  minute: 'min', minutes: 'min', mins: 'min',
  hour: 'h', hours: 'h', hr: 'h', hrs: 'h',
  day: 'd', days: 'd',
  week: 'wk', weeks: 'wk',
  year: 'yr', years: 'yr',
  acre: 'acre', acres: 'acre',
  hectare: 'ha', hectares: 'ha',
  'square metre': 'm2', 'square metres': 'm2', 'square meter': 'm2', 'square meters': 'm2',
  'square kilometre': 'km2', 'square kilometres': 'km2',
  'square kilometre ': 'km2', 'sq km': 'km2', 'sq m': 'm2',
  'square foot': 'ft2', 'square feet': 'ft2', 'sq ft': 'ft2',
  'square mile': 'mi2', 'square miles': 'mi2', 'sq mi': 'mi2',
  'km/h': 'kph', kmh: 'kph', mph: 'mph', 'm/s': 'mps',
  'metres per second': 'mps', 'meters per second': 'mps',
  'kilometres per hour': 'kph', 'kilometers per hour': 'kph',
  'miles per hour': 'mph', knots: 'knot',
};

const TEMP_ALIASES = {
  c: 'celsius', celsius: 'celsius', centigrade: 'celsius', '°c': 'celsius',
  f: 'fahrenheit', fahrenheit: 'fahrenheit', '°f': 'fahrenheit',
  k: 'kelvin', kelvin: 'kelvin', '°k': 'kelvin',
};

function resolveUnit(token) {
  if (!token) return null;
  const key = token.toLowerCase().trim().replace(/\s+/g, ' ').replace(/^°\s*/, '°');
  if (UNITS[key]) return { kind: 'unit', key };
  if (UNIT_ALIASES[key] && UNITS[UNIT_ALIASES[key]]) return { kind: 'unit', key: UNIT_ALIASES[key] };
  if (TEMP_ALIASES[key]) return { kind: 'temp', key: TEMP_ALIASES[key] };
  // "fahrenheit" typed as "f°" or "° f" — normalise the degree marker away.
  const stripped = key.replace(/^°|°$/g, '').trim();
  if (TEMP_ALIASES[stripped]) return { kind: 'temp', key: TEMP_ALIASES[stripped] };
  if (UNITS[stripped]) return { kind: 'unit', key: stripped };
  if (UNIT_ALIASES[stripped] && UNITS[UNIT_ALIASES[stripped]]) {
    return { kind: 'unit', key: UNIT_ALIASES[stripped] };
  }
  return null;
}

const TEMP_SYMBOLS = { celsius: '°C', fahrenheit: '°F', kelvin: 'K' };

function toCelsius(value, scale) {
  if (scale === 'celsius') return value;
  if (scale === 'fahrenheit') return ((value - 32) * 5) / 9;
  return value - 273.15;
}

function fromCelsius(value, scale) {
  if (scale === 'celsius') return value;
  if (scale === 'fahrenheit') return (value * 9) / 5 + 32;
  return value + 273.15;
}

/**
 * Attempt a unit conversion.
 * Understands "10 kg in lbs", "100 f to c", "30mph in kph",
 * "5 square feet in square metres", "1/2 cup in ml".
 */
function convert(query) {
  const text = String(query || '').trim().toLowerCase();
  // Split on the separator so multi-word unit names survive intact.
  const match = /^(-?\d+(?:\.\d+)?)\s+(.+?)\s+(?:in|to|as|into)\s+(.+)$/i.exec(text)
    // Also accept the compact form with no spaces around the number's unit.
    || /^(-?\d+(?:\.\d+)?)([a-z°]+)\s*(?:in|to|as|into)\s*([a-z°/"'²³]+)$/i.exec(text);
  if (!match) return null;

  const amount = parseFloat(match[1]);
  const from = resolveUnit(match[2]);
  const to = resolveUnit(match[3]);
  if (!from || !to) return null;

  // Temperature needs its own path — it is not a linear factor.
  if (from.kind === 'temp' || to.kind === 'temp') {
    if (from.kind !== 'temp' || to.kind !== 'temp') return null;
    const celsius = toCelsius(amount, from.key);
    const result = fromCelsius(celsius, to.key);
    const pretty = `${round(amount)} ${TEMP_SYMBOLS[from.key]} = ${round(result)} ${TEMP_SYMBOLS[to.key]}`;
    return {
      kind: 'conversion',
      title: pretty,
      value: result,
      detail: pretty,
    };
  }

  if (from.cat !== to.cat) return null;

  const fromUnit = UNITS[from.key];
  const toUnit = UNITS[to.key];
  const base = amount * fromUnit.factor;
  const result = base / toUnit.factor;

  return {
    kind: 'conversion',
    title: `${round(result)} ${toUnit.name}`,
    value: result,
    detail: `${round(amount)} ${fromUnit.name} = ${round(result)} ${toUnit.name}`,
  };
}

function round(value) {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  const abs = Math.abs(value);
  if (abs < 1e-6 || abs >= 1e12) return value.toExponential(4);
  // Four significant figures is plenty for a unit conversion.
  return String(Number(value.toPrecision(4)));
}

/* ---------------------------------------------------------------- weather */

const WEATHER_CODES = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Depositing rime fog', 51: 'Light drizzle', 53: 'Drizzle',
  55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain',
  67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  77: 'Snow grains', 80: 'Light showers', 81: 'Showers', 82: 'Violent showers',
  85: 'Light snow showers', 86: 'Snow showers', 95: 'Thunderstorm',
  96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail',
};

async function geocode(place, { signal } = {}) {
  const params = new URLSearchParams({ name: place, count: '1', language: 'en', format: 'json' });
  const response = await getJson(`https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`, {
    timeout: 6000,
    retries: 1,
    signal,
    headers: { Accept: 'application/json' },
  });
  const hit = response.json?.results?.[0];
  if (!hit) return null;
  return {
    name: hit.name,
    country: hit.country || '',
    admin1: hit.admin1 || '',
    latitude: hit.latitude,
    longitude: hit.longitude,
    timezone: hit.timezone,
  };
}

async function weather(query, { signal } = {}) {
  const match = /^(?:weather|temperature|forecast)\s+(?:in|for|at)\s+(.+)$/i.exec(query.trim())
    || /^(?:weather|temperature|forecast)\s+(.+)$/i.exec(query.trim());
  if (!match) return null;

  const place = match[1].trim();
  if (!place || place.length > 60) return null;

  const cached = cache.get(`w:${place.toLowerCase()}`);
  if (cached) return cached;

  const location = await geocode(place, { signal });
  if (!location) return null;

  const params = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min,weather_code',
    timezone: 'auto',
    forecast_days: '3',
  });

  const response = await getJson(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, {
    timeout: 7000,
    retries: 1,
    signal,
    headers: { Accept: 'application/json' },
  });

  const current = response.json?.current;
  if (!current) return null;

  const daily = response.json?.daily;
  const result = {
    kind: 'weather',
    title: `${Math.round(current.temperature_2m)}°C in ${location.name}`,
    detail: [
      WEATHER_CODES[current.weather_code] || 'Unknown conditions',
      `Feels like ${Math.round(current.apparent_temperature)}°C`,
      `Humidity ${current.relative_humidity_2m}%`,
      `Wind ${Math.round(current.wind_speed_10m)} km/h`,
    ].join(' · '),
    location: `${location.name}${location.country ? `, ${location.country}` : ''}`,
    temperature: Math.round(current.temperature_2m),
    unit: '°C',
    high: daily ? Math.round(daily.temperature_2m_max?.[0] ?? current.temperature_2m) : null,
    low: daily ? Math.round(daily.temperature_2m_min?.[0] ?? current.temperature_2m) : null,
    forecast: (daily?.time || []).map((day, index) => ({
      day,
      high: Math.round(daily.temperature_2m_max?.[index] ?? 0),
      low: Math.round(daily.temperature_2m_min?.[index] ?? 0),
      code: daily.weather_code?.[index] ?? 0,
      label: WEATHER_CODES[daily.weather_code?.[index]] || '',
    })),
  };

  cache.set(`w:${place.toLowerCase()}`, result);
  return result;
}

/* ------------------------------------------------------------ definitions */

async function definition(query, { signal } = {}) {
  const match = /^(?:define|definition of|meaning of)\s+(.+)$/i.exec(query.trim());
  if (!match) return null;

  const word = match[1].trim().toLowerCase();
  if (!word || word.length > 40 || !/^[a-z' -]+$/i.test(word)) return null;

  const cached = cache.get(`d:${word}`);
  if (cached) return cached;

  const response = await getJson(
    `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
    { timeout: 6000, retries: 1, signal, headers: { Accept: 'application/json' } },
  );

  const entries = Array.isArray(response.json) ? response.json : [];
  if (!entries.length) return null;

  const entry = entries[0];
  const meanings = (entry.meanings || []).slice(0, 3).map((meaning) => {
    const definition = (meaning.definitions || [])[0];
    return {
      partOfSpeech: meaning.partOfSpeech || '',
      definition: cleanText(definition?.definition || ''),
      example: cleanText(definition?.example || ''),
      synonyms: (definition?.synonyms || []).slice(0, 5),
    };
  }).filter((m) => m.definition);

  if (!meanings.length) return null;

  const result = {
    kind: 'definition',
    title: entry.word || word,
    phonetic: entry.phonetic || (entry.phonetics || []).map((p) => p.text).find(Boolean) || '',
    audio: (entry.phonetics || []).map((p) => p.audio).find(Boolean) || '',
    meanings,
  };

  cache.set(`d:${word}`, result);
  return result;
}

/* ------------------------------------------------------------------- time */

async function localTime(query, { signal } = {}) {
  const match = /^(?:time|date)\s+(?:in|at|for)\s+(.+)$/i.exec(query.trim());
  if (!match) return null;

  const place = match[1].trim();
  if (!place || place.length > 60) return null;

  const cached = cache.get(`t:${place.toLowerCase()}`);
  if (cached) return cached;

  const location = await geocode(place, { signal });
  if (!location || !location.timezone) return null;

  const now = new Date();
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: location.timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(now);

  const result = {
    kind: 'time',
    title: formatted,
    detail: `${location.name}, ${location.timezone}`,
  };

  cache.set(`t:${place.toLowerCase()}`, result);
  return result;
}

/* -------------------------------------------------------------- dispatcher */

/**
 * Compute the best instant answer for a query.
 * @returns {Promise<object|null>}
 */
async function instantAnswer(query, { signal } = {}) {
  if (!query) return null;
  const text = query.trim();

  // Local, instant, and always available.
  const calculation = evaluate(text);
  if (calculation) {
    return {
      kind: 'calculation',
      title: calculation.formatted,
      detail: `${calculation.expression} = ${calculation.formatted}`,
      expression: calculation.expression,
      value: calculation.value,
    };
  }

  const conversion = convert(text);
  if (conversion) return conversion;

  // Network-backed answers.
  const attempts = [weather, definition, localTime];
  for (const attempt of attempts) {
    try {
      const answer = await attempt(text, { signal });
      if (answer) return answer;
    } catch {
      /* instant answers are best-effort */
    }
  }

  return null;
}

module.exports = { instantAnswer, evaluate, convert, weather, definition, localTime, UNITS };
