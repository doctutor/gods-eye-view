// Personal fork: the pure parts of the MSFS renderer's operator script
// (msfs.mjs): its arguments, the caller's address, the template with its
// user-data, the AWS CLI arguments and the cost arithmetic. No AWS here.
// Not part of upstream God's Eye View.
import path from 'node:path';

export const STACK = 'gev-msfs-renderer';
export const KEY_NAME = 'gev-msfs-renderer';
export const DEFAULTS = Object.freeze({
  region: 'us-east-1',
  profile: 'gev-msfs',
  instanceType: 'g5.2xlarge',
  rootGb: 150,
});

/** Running On-Demand G and VT instances: vCPUs, 0 on a new account. */
export const QUOTA = Object.freeze({
  serviceCode: 'ec2',
  quotaCode: 'L-DB2E81BA',
  name: 'Running On-Demand G and VT instances',
  desired: 8,
});

/**
 * us-east-1 prices, USD. Instances: Windows On-Demand, from AWS's public
 * price data (pricing/2.0/.../ec2-ondemand-without-sec-sel, published
 * 2026-10-15). Transfer out and public IPv4: the price list API offers
 * AWSDataTransfer (2026-09-16) and AmazonVPC (2026-10-16). gp3: the EBS
 * pricing page.
 */
export const PRICES = Object.freeze({
  asOf: '2026-10-15',
  instanceHour: Object.freeze({
    'g5.xlarge': 1.19,
    'g5.2xlarge': 1.58,
    'g5.4xlarge': 2.36,
  }),
  gp3GbMonth: 0.08,
  publicIpv4Hour: 0.005,
  transferOutGb: 0.09,
  transferFreeGbMonth: 100,
  hoursPerMonth: 730,
});

export const COMMANDS = Object.freeze([
  'deploy',
  'start',
  'stop',
  'status',
  'destroy',
  'quota',
]);

const FLAGS = Object.freeze({
  '--region': 'region',
  '--profile': 'profile',
  '--ip': 'ip',
  '--instance-type': 'instanceType',
  '--root-gb': 'rootGb',
  '--confirm': 'confirm',
  '--gb-out': 'gbOut',
});

/** `msfs.mjs <command> [--flag value]...` as {command, region, ...}. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command))
    throw new Error(
      `usage: msfs.mjs <${COMMANDS.join('|')}> [--region R] [--profile P] [--ip A.B.C.D] [--instance-type T] [--root-gb N] [--confirm ${STACK}] [--gb-out N]`,
    );
  const options = { command, ...DEFAULTS, ip: null, confirm: null, gbOut: 0 };
  for (let i = 0; i < rest.length; i++) {
    const [flag, inline] = rest[i].split(/=(.*)/s, 2);
    const key = FLAGS[flag];
    if (!key) throw new Error(`unknown option ${rest[i]}`);
    const value = inline ?? rest[++i];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`${flag} needs a value`);
    options[key] = value;
  }
  options.rootGb = Number(options.rootGb);
  options.gbOut = Number(options.gbOut);
  if (
    !Number.isInteger(options.rootGb) ||
    options.rootGb < 100 ||
    options.rootGb > 1000
  )
    throw new Error('--root-gb is 100 to 1000');
  if (!Number.isFinite(options.gbOut) || options.gbOut < 0)
    throw new Error('--gb-out is a number of GB');
  if (!(options.instanceType in PRICES.instanceHour))
    throw new Error(
      `--instance-type is one of ${Object.keys(PRICES.instanceHour).join(', ')}`,
    );
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(options.region))
    throw new Error(`--region ${options.region} is not a region name`);
  if (!/^[\w+=,.@-]{1,128}$/.test(options.profile))
    throw new Error(`--profile ${options.profile} is not a profile name`);
  if (options.ip) options.ip = cidrOf(options.ip);
  return options;
}

/** An IPv4 address as a /32, checked; throws otherwise. */
export function cidrOf(text) {
  const value = String(text ?? '')
    .trim()
    .replace(/\/32$/, '');
  const parts = value.split('.');
  if (
    parts.length !== 4 ||
    !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  )
    throw new Error(
      `not an IPv4 address: ${JSON.stringify(String(text ?? '').slice(0, 60))}`,
    );
  return `${parts.map(Number).join('.')}/32`;
}

/** checkip.amazonaws.com's answer (the address and a newline) as a /32. */
export const parseCheckIp = (body) => cidrOf(String(body ?? '').split('\n')[0]);

const USER_DATA_LINE = /^( *)# USER_DATA\r?$/m;

/**
 * The template with user-data.ps1 in its UserData block, indented under
 * the `Fn::Base64: |` literal. CloudFormation takes a template body of up
 * to 51,200 bytes and EC2 user-data of up to 16 KB.
 */
export function buildTemplate(template, userData) {
  const match = USER_DATA_LINE.exec(template);
  if (!match) throw new Error('template.yaml has no "# USER_DATA" line');
  const script = String(userData).replace(/\r\n/g, '\n').replace(/\n+$/, '');
  if (/\t/.test(script))
    throw new Error(
      'user-data.ps1 has a tab (YAML literal blocks need spaces)',
    );
  const userDataBytes = Buffer.byteLength(
    `<powershell>\n${script}\n</powershell>\n`,
  );
  if (userDataBytes > 16 * 1024)
    throw new Error(
      `the user-data is ${userDataBytes} bytes, over EC2's 16 KB`,
    );
  const indent = match[1];
  const body = script
    .split('\n')
    .map((line) => (line ? indent + line : ''))
    .join('\n');
  const out = template.replace(USER_DATA_LINE, () => body);
  const bytes = Buffer.byteLength(out);
  if (bytes > 51_200)
    throw new Error(
      `the template is ${bytes} bytes, over CloudFormation's 51,200 for a template body`,
    );
  return out;
}

/** AWS CLI arguments with the profile, the region and JSON output. */
export function awsArgs(args, { profile, region }, { json = true } = {}) {
  return [
    ...args,
    '--profile',
    profile,
    '--region',
    region,
    ...(json ? ['--output', 'json'] : []),
  ];
}

/** Hours since a launch time (the instance's LaunchTime is this session's start). */
export function sessionHours(launchTime, now = Date.now()) {
  const at = Date.parse(launchTime);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, (now - at) / 3_600_000);
}

const cents = (value) => Math.round(value * 100) / 100;

/**
 * What a session costs: compute and its public address per hour; the
 * volume per month whether running or not (and its share for the hours);
 * transfer out past the monthly free 100 GB (all of the account's).
 */
export function costEstimate({
  instanceType = DEFAULTS.instanceType,
  hours = 0,
  rootGb = DEFAULTS.rootGb,
  gbOut = 0,
  freeGbLeft = PRICES.transferFreeGbMonth,
}) {
  const hourly = PRICES.instanceHour[instanceType];
  if (hourly === undefined) throw new Error(`no price for ${instanceType}`);
  const compute = hours * hourly;
  const ipv4 = hours * PRICES.publicIpv4Hour;
  const storageMonth = rootGb * PRICES.gp3GbMonth;
  const storage = (storageMonth * hours) / PRICES.hoursPerMonth;
  const transfer = Math.max(0, gbOut - freeGbLeft) * PRICES.transferOutGb;
  return {
    hourly: cents(hourly + PRICES.publicIpv4Hour),
    compute: cents(compute),
    ipv4: cents(ipv4),
    storage: cents(storage),
    storageMonth: cents(storageMonth),
    transfer: cents(transfer),
    total: cents(compute + ipv4 + storage + transfer),
  };
}

export const money = (value) => `$${value.toFixed(2)}`;

/** Where the key pair's private key is kept (never in the repository). */
export const pemPath = (home) =>
  path.join(home, '.gev-secrets', `${KEY_NAME}.pem`);

/** A stack's outputs as {key: value}. */
export function stackOutputs(describeStacks) {
  const outputs = describeStacks?.Stacks?.[0]?.Outputs || [];
  return Object.fromEntries(outputs.map((o) => [o.OutputKey, o.OutputValue]));
}
