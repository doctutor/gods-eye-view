// Personal fork: the MSFS renderer's operator script (tools/msfs-renderer/):
// its template and user-data, the caller's address, the cost arithmetic,
// the arguments, and each command against a fake AWS CLI. No AWS is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULTS,
  PRICES,
  QUOTA,
  STACK,
  awsArgs,
  awsExecutable,
  buildTemplate,
  cidrOf,
  costEstimate,
  parseArgs,
  parseCheckIp,
  pemPath,
  sessionHours,
} from '../../tools/msfs-renderer/lib.mjs';
import {
  commands,
  createAws,
  detectIp,
} from '../../tools/msfs-renderer/msfs.mjs';

const DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tools/msfs-renderer',
);
const TEMPLATE = fs.readFileSync(path.join(DIR, 'template.yaml'), 'utf8');
const USER_DATA = fs.readFileSync(path.join(DIR, 'user-data.ps1'), 'utf8');

test('the template: one tagged instance, RDP and Parsec from one address, the driver buckets, never terminated by accident', () => {
  // The resources and their tags.
  for (const resource of [
    'SecurityGroup',
    'InstanceRole',
    'InstanceProfile',
    'Instance',
  ])
    assert.match(
      TEMPLATE,
      new RegExp(`^  ${resource}:\\n    Type: AWS::`, 'm'),
      resource,
    );
  assert.equal((TEMPLATE.match(/Value: gev-msfs-renderer$/gm) || []).length, 5);
  // Ingress: 3389/tcp, 8000-8010 tcp and udp, each from AllowedCidr only.
  const ingress = TEMPLATE.slice(
    TEMPLATE.indexOf('SecurityGroupIngress:'),
    TEMPLATE.indexOf('  InstanceRole:'),
  );
  assert.deepEqual(
    [
      ...ingress.matchAll(
        /IpProtocol: (\w+)\n\s+FromPort: (\d+)\n\s+ToPort: (\d+)\n\s+CidrIp: !Ref AllowedCidr/g,
      ),
    ].map((m) => m.slice(1).join(' ')),
    ['tcp 3389 3389', 'tcp 8000 8010', 'udp 8000 8010'],
  );
  assert.doesNotMatch(TEMPLATE, /0\.0\.0\.0\/0/);
  assert.match(
    TEMPLATE,
    /AllowedPattern: '\^\(\\d\{1,3\}\\\.\)\{3\}\\d\{1,3\}\/32\$'/,
  );
  // The machine.
  assert.match(
    TEMPLATE,
    /InstanceType:\n\s+Type: String\n\s+Default: g5\.2xlarge/,
  );
  assert.match(
    TEMPLATE,
    /Type: AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>\n\s+Default: \/aws\/service\/ami-windows-latest\/Windows_Server-2022-English-Full-Base/,
  );
  assert.match(TEMPLATE, /RootVolumeGb:\n\s+Type: Number\n\s+Default: 150/);
  assert.match(TEMPLATE, /VolumeType: gp3\n\s+VolumeSize: !Ref RootVolumeGb/);
  assert.match(TEMPLATE, /DisableApiTermination: true/);
  assert.match(TEMPLATE, /InstanceInitiatedShutdownBehavior: stop/);
  assert.match(TEMPLATE, /HttpTokens: required/);
  // The role: SSM, and read access to both NVIDIA buckets.
  assert.match(
    TEMPLATE,
    /arn:aws:iam::aws:policy\/AmazonSSMManagedInstanceCore/,
  );
  for (const bucket of ['nvidia-gaming', 'ec2-windows-nvidia-drivers']) {
    assert.match(TEMPLATE, new RegExp(`- arn:aws:s3:::${bucket}\\n`));
    assert.match(TEMPLATE, new RegExp(`- arn:aws:s3:::${bucket}/\\*`));
  }
  assert.match(TEMPLATE, /Path: \/gev-msfs-renderer\//);
});

test('the user-data: AWS’s gaming-driver procedure, the apps, no auto-restart, one restart, a log', () => {
  for (const pattern of [
    /Start-Transcript -Path 'C:\\gev-provision\.log'/,
    /Get-S3Object -BucketName 'nvidia-gaming' -KeyPrefix 'windows\/latest' -Region us-east-1/,
    /HKLM\\SYSTEM\\CurrentControlSet\\Services\\nvlddmkm\\Global/,
    /vGamingMarketplace \/t REG_DWORD \/d 2 \/f \/reg:64/,
    /GridSwCert_2026_03_02\.cert/,
    /GridSwCertWindows_2025_07_01\.cert/,
    /\$Env:PUBLIC\\Documents\\GridSwCert\.txt/,
    /parsec-windows\.exe' 'parsec-windows\.exe'\) @\('\/silent', '\/shared'\)/,
    /SteamSetup\.exe' 'SteamSetup\.exe'\) @\('\/S'\)/,
    /obsproject\/obs-studio/,
    /ip7z\/7zip/,
    /NoAutoRebootWithLoggedOnUsers/,
    /Set-Service -Name 'Audiosrv' -StartupType Automatic/,
    /shutdown\.exe \/r \/t 60/,
  ])
    assert.match(USER_DATA, pattern);
  assert.equal(
    (USER_DATA.match(/shutdown\.exe/g) || []).length,
    1,
    'one restart',
  );
});

test('the template with its user-data: indented into the literal block, within the size limits', () => {
  const built = buildTemplate(TEMPLATE, USER_DATA);
  assert.doesNotMatch(built, /# USER_DATA/);
  const block = built.slice(
    built.indexOf('Fn::Base64: |'),
    built.indexOf('</powershell>'),
  );
  const lines = block.split('\n').slice(1).filter(Boolean);
  assert.equal(lines[0], '          <powershell>');
  assert.ok(
    lines.every((line) => line.startsWith('          ')),
    'every line under the literal',
  );
  assert.match(block, /          \$ErrorActionPreference = 'Stop'/);
  assert.ok(Buffer.byteLength(built) < 51_200);
  assert.throws(
    () => buildTemplate('no marker', USER_DATA),
    /no "# USER_DATA" line/,
  );
  assert.throws(() => buildTemplate(TEMPLATE, 'a\tb'), /tab/);
  assert.throws(() => buildTemplate(TEMPLATE, 'x'.repeat(17_000)), /16 KB/);
});

test('the caller’s address: checkip’s answer as a /32, anything else refused', () => {
  assert.equal(parseCheckIp('203.0.113.7\n'), '203.0.113.7/32');
  assert.equal(cidrOf(' 198.51.100.1/32 '), '198.51.100.1/32');
  assert.equal(cidrOf('010.001.002.003'), '10.1.2.3/32');
  for (const bad of [
    '',
    '2001:db8::1',
    '256.1.1.1',
    '1.2.3',
    '1.2.3.4/24',
    '<html>',
  ])
    assert.throws(() => cidrOf(bad), /not an IPv4 address/, bad);
});

test('the arguments: a command, defaults, flags in both forms, nonsense refused', () => {
  assert.deepEqual(parseArgs(['status']), {
    command: 'status',
    ...DEFAULTS,
    ip: null,
    confirm: null,
    gbOut: 0,
  });
  const options = parseArgs([
    'deploy',
    '--region',
    'eu-west-1',
    '--ip=203.0.113.7',
    '--root-gb',
    '200',
    '--instance-type',
    'g5.xlarge',
  ]);
  assert.equal(options.region, 'eu-west-1');
  assert.equal(options.ip, '203.0.113.7/32');
  assert.equal(options.rootGb, 200);
  assert.equal(options.instanceType, 'g5.xlarge');
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['terminate']), /usage/);
  assert.throws(() => parseArgs(['start', '--force']), /unknown option/);
  assert.throws(() => parseArgs(['start', '--region']), /needs a value/);
  assert.throws(() => parseArgs(['start', '--region', 'mars']), /not a region/);
  assert.throws(() => parseArgs(['start', '--root-gb', '50']), /100 to 1000/);
  assert.throws(
    () => parseArgs(['start', '--instance-type', 'p5.48xlarge']),
    /one of/,
  );
  assert.throws(() => parseArgs(['start', '--profile', 'a b']), /profile/);
  assert.deepEqual(awsArgs(['ec2', 'stop-instances'], DEFAULTS), [
    'ec2',
    'stop-instances',
    '--profile',
    'gev-msfs',
    '--region',
    'us-east-1',
    '--output',
    'json',
  ]);
  assert.deepEqual(awsArgs(['x'], DEFAULTS, { json: false }).slice(-2), [
    '--region',
    'us-east-1',
  ]);
});

test('the cost: per hour while running, the volume every month, transfer past the free 100 GB', () => {
  assert.equal(PRICES.instanceHour['g5.2xlarge'], 1.58);
  const hour = costEstimate({ hours: 1 });
  assert.equal(
    hour.hourly,
    1.59,
    '1.58 + 0.005 for the public address, rounded',
  );
  assert.equal(hour.compute, 1.58);
  assert.equal(hour.storageMonth, 12, '150 GB × $0.08');
  assert.equal(hour.storage, 0.02, '12 / 730 h');
  const evening = costEstimate({ hours: 4, gbOut: 150 });
  assert.equal(evening.compute, 6.32);
  assert.equal(evening.ipv4, 0.02);
  assert.equal(evening.transfer, 4.5, '50 GB past the free 100, × $0.09');
  assert.equal(evening.total, 6.32 + 0.02 + 0.07 + 4.5);
  assert.equal(costEstimate({ hours: 2, gbOut: 50 }).transfer, 0);
  assert.throws(() => costEstimate({ instanceType: 'x1.huge' }), /no price/);
  assert.equal(
    sessionHours('2026-10-21T10:00:00Z', Date.parse('2026-10-21T13:30:00Z')),
    3.5,
  );
  assert.equal(sessionHours('not a date'), 0);
});

/** A fake AWS CLI: the answers by command, every call recorded. */
function fakeContext({
  answers = {},
  options = {},
  files = {},
  typed = null,
  ip = '203.0.113.7',
} = {}) {
  const calls = [];
  const lines = [];
  const written = {};
  const ctx = {
    options: { ...DEFAULTS, ip: null, confirm: null, gbOut: 0, ...options },
    calls,
    lines,
    written,
    home: '/home/pilot',
    now: () => Date.parse('2026-10-21T14:00:00Z'),
    log: (line) => lines.push(line),
    prompt: async () => typed,
    fetch: async (url) => {
      calls.push(['fetch', url]);
      return { ok: true, status: 200, text: async () => `${ip}\n` };
    },
    files: {
      exists: (file) => file in files || file in written,
      read: (file) => fs.readFileSync(file, 'utf8'),
      writeTemp: (name, text) => (
        (written[`/tmp/${name}`] = text),
        `/tmp/${name}`
      ),
      writeSecret: (file, text) => (written[file] = text),
    },
    aws: async (args, { json = true } = {}) => {
      calls.push(args);
      const key = args.slice(0, 2).join(' ');
      const answer = answers[key];
      if (answer instanceof Error) throw answer;
      if (typeof answer === 'function') return answer(args, json);
      return answer ?? {};
    },
  };
  return ctx;
}

const STACK_ANSWER = {
  Stacks: [
    {
      Outputs: [
        { OutputKey: 'InstanceId', OutputValue: 'i-0abc' },
        { OutputKey: 'AllowedCidr', OutputValue: '203.0.113.7/32' },
      ],
      Parameters: [{ ParameterKey: 'RootVolumeGb', ParameterValue: '150' }],
    },
  ],
};
const instanceAnswer = (state, extra = {}) => ({
  Reservations: [
    {
      Instances: [
        {
          InstanceId: 'i-0abc',
          InstanceType: 'g5.2xlarge',
          State: { Name: state },
          LaunchTime: '2026-10-21T12:00:00Z',
          ...(state === 'running' ? { PublicIpAddress: '54.0.0.9' } : {}),
          ...extra,
        },
      ],
    },
  ],
});
const notFound = (text) => Object.assign(new Error(text), { stderr: text });

test('deploy: the key pair made once (its key to ~/.gev-secrets, never printed), the stack deployed, the way in printed', async () => {
  const ctx = fakeContext({
    answers: {
      'sts get-caller-identity': { Account: '111122223333' },
      'ec2 describe-key-pairs': notFound(
        'An error occurred (InvalidKeyPair.NotFound)',
      ),
      'ec2 create-key-pair': (args, json) => {
        assert.equal(json, false);
        assert.deepEqual(args.slice(-4), [
          '--query',
          'KeyMaterial',
          '--output',
          'text',
        ]);
        return '-----BEGIN RSA PRIVATE KEY-----\nSECRET\n-----END RSA PRIVATE KEY-----';
      },
      'cloudformation describe-stacks': STACK_ANSWER,
      'ec2 describe-instances': instanceAnswer('running'),
    },
  });
  await commands.deploy(ctx);
  const pem = pemPath('/home/pilot');
  assert.match(ctx.written[pem], /SECRET/);
  assert.ok(
    !ctx.lines.join('\n').includes('SECRET'),
    'the key is never printed',
  );
  const deploy = ctx.calls.find((c) => c[1] === 'deploy');
  assert.deepEqual(deploy.slice(0, 7), [
    'cloudformation',
    'deploy',
    '--stack-name',
    STACK,
    '--template-file',
    '/tmp/gev-msfs-renderer.template.yaml',
    '--capabilities',
  ]);
  assert.ok(deploy.includes('AllowedCidr=203.0.113.7/32'));
  assert.ok(deploy.includes('KeyName=gev-msfs-renderer'));
  assert.ok(deploy.includes('InstanceType=g5.2xlarge'));
  assert.ok(deploy.includes('--no-fail-on-empty-changeset'));
  assert.match(
    ctx.written['/tmp/gev-msfs-renderer.template.yaml'],
    /Get-S3Object -BucketName 'nvidia-gaming'/,
  );
  const out = ctx.lines.join('\n');
  assert.match(out, /mstsc \/v:54\.0\.0\.9/);
  assert.match(
    out,
    /aws ec2 get-password-data --instance-id i-0abc --priv-launch-key ".*gev-msfs-renderer\.pem" --profile gev-msfs --region us-east-1/,
  );
  assert.ok(
    !ctx.calls.some((c) => c[1] === 'get-password-data'),
    'the password is never fetched',
  );
});

test('deploy refuses when AWS has the key pair and this PC lost its key', async () => {
  const ctx = fakeContext({
    answers: {
      'sts get-caller-identity': { Account: '111122223333' },
      'ec2 describe-key-pairs': {
        KeyPairs: [{ KeyName: 'gev-msfs-renderer' }],
      },
    },
  });
  await assert.rejects(commands.deploy(ctx), /AWS keeps no copy/);
  assert.ok(!ctx.calls.some((c) => c[1] === 'deploy'));
});

test('start: the security group follows a new address, then the instance starts; stop waits for it', async () => {
  let state = 'stopped';
  const ctx = fakeContext({
    ip: '198.51.100.4',
    answers: {
      'cloudformation describe-stacks': STACK_ANSWER,
      'ec2 describe-instances': () => instanceAnswer(state),
      'ec2 start-instances': () => ((state = 'running'), {}),
    },
  });
  await commands.start(ctx);
  const update = ctx.calls.find((c) => c[1] === 'update-stack');
  assert.ok(
    update.includes('ParameterKey=AllowedCidr,ParameterValue=198.51.100.4/32'),
  );
  assert.ok(update.includes('--use-previous-template'));
  assert.ok(
    ctx.calls.some(
      (c) => c.join(' ') === 'ec2 wait instance-running --instance-ids i-0abc',
    ),
  );
  assert.match(ctx.lines.join('\n'), /\$1\.59\/h while running/);
  // Same address: no stack update.
  const same = fakeContext({
    answers: {
      'cloudformation describe-stacks': STACK_ANSWER,
      'ec2 describe-instances': instanceAnswer('running'),
    },
  });
  await commands.start(same);
  assert.ok(!same.calls.some((c) => c[1] === 'update-stack'));
  assert.ok(
    !same.calls.some((c) => c[1] === 'start-instances'),
    'already running',
  );
  // Stop.
  const stopping = fakeContext({
    answers: {
      'cloudformation describe-stacks': STACK_ANSWER,
      'ec2 describe-instances': instanceAnswer('running'),
    },
  });
  await commands.stop(stopping);
  assert.ok(
    stopping.calls.some(
      (c) => c.join(' ') === 'ec2 wait instance-stopped --instance-ids i-0abc',
    ),
  );
  assert.match(stopping.lines.at(-1), /Only its 150 GB volume is billed now/);
});

test('status: running with this session’s cost, or stopped with the volume’s', async () => {
  const running = fakeContext({
    options: { gbOut: 120 },
    answers: {
      'cloudformation describe-stacks': STACK_ANSWER,
      'ec2 describe-instances': instanceAnswer('running'),
    },
  });
  await commands.status(running);
  const out = running.lines.join('\n');
  // 2 h since 12:00: 3.16 compute + 0.01 address + 0.03 volume + 1.80 transfer.
  assert.match(
    out,
    /This session: 2\.00 h since 2026-10-21T12:00:00Z, about \$5\.00/,
  );
  assert.match(out, /Volume: \$12\.00\/month/);
  const stopped = fakeContext({
    answers: {
      'cloudformation describe-stacks': STACK_ANSWER,
      'ec2 describe-instances': instanceAnswer('stopped'),
    },
  });
  await commands.status(stopped);
  assert.match(
    stopped.lines[0],
    /stopped\. Billed now: the 150 GB volume, \$12\.00\/month/,
  );
  const none = fakeContext({
    answers: {
      'cloudformation describe-stacks': notFound(
        'Stack with id gev-msfs-renderer does not exist',
      ),
    },
  });
  await assert.rejects(commands.status(none), /run npm run msfs:deploy/);
});

test('destroy: only with the stack’s name typed; termination protection lifted first', async () => {
  const answers = {
    'cloudformation describe-stacks': STACK_ANSWER,
    'ec2 describe-instances': instanceAnswer('stopped'),
  };
  const refused = fakeContext({ answers, typed: 'yes' });
  await commands.destroy(refused);
  assert.ok(!refused.calls.some((c) => c[1] === 'delete-stack'));
  assert.match(refused.lines.at(-1), /nothing deleted/);
  const confirmed = fakeContext({ answers, typed: 'gev-msfs-renderer' });
  await commands.destroy(confirmed);
  const order = confirmed.calls.map((c) => c.slice(0, 2).join(' '));
  assert.ok(
    order.indexOf('ec2 modify-instance-attribute') <
      order.indexOf('cloudformation delete-stack'),
  );
  assert.ok(
    confirmed.calls.some((c) => c.includes('--no-disable-api-termination')),
  );
  const flagged = fakeContext({
    answers,
    options: { confirm: 'gev-msfs-renderer' },
  });
  await commands.destroy(flagged);
  assert.ok(flagged.calls.some((c) => c[1] === 'delete-stack'));
});

test('quota: reported, requested once at 8 vCPUs, not again while a request is open', async () => {
  const fresh = fakeContext({
    answers: {
      'service-quotas get-service-quota': notFound('NoSuchResourceException'),
      'service-quotas get-aws-default-service-quota': { Quota: { Value: 0 } },
      'service-quotas list-requested-service-quota-change-history-by-quota': {
        RequestedQuotas: [],
      },
      'service-quotas request-service-quota-increase': {
        RequestedQuota: { Id: 'r-1', Status: 'PENDING' },
      },
    },
  });
  await commands.quota(fresh);
  const request = fresh.calls.find(
    (c) => c[1] === 'request-service-quota-increase',
  );
  assert.deepEqual(request.slice(2), [
    '--service-code',
    'ec2',
    '--quota-code',
    QUOTA.quotaCode,
    '--desired-value',
    '8',
  ]);
  assert.match(
    fresh.lines[0],
    /Running On-Demand G and VT instances \(L-DB2E81BA\) in us-east-1: 0 vCPUs \(a g5\.2xlarge needs 8\)/,
  );
  const pending = fakeContext({
    answers: {
      'service-quotas get-service-quota': { Quota: { Value: 0 } },
      'service-quotas list-requested-service-quota-change-history-by-quota': {
        RequestedQuotas: [
          {
            Id: 'r-1',
            Status: 'CASE_OPENED',
            DesiredValue: 8,
            Created: '2026-10-21',
          },
        ],
      },
    },
  });
  await commands.quota(pending);
  assert.ok(
    !pending.calls.some((c) => c[1] === 'request-service-quota-increase'),
  );
  assert.match(pending.lines.at(-1), /CASE_OPENED/);
  const enough = fakeContext({
    answers: { 'service-quotas get-service-quota': { Quota: { Value: 8 } } },
  });
  await commands.quota(enough);
  assert.match(enough.lines.at(-1), /nothing to request/);
});

test('the AWS CLI runner: the profile and region added, JSON parsed, errors carry stderr; checkip read', async () => {
  const seen = [];
  const aws = createAws(
    DEFAULTS,
    (file, args, _options, done) => {
      seen.push([file, ...args]);
      if (args[1] === 'fail')
        return done(
          new Error('exit 255'),
          '',
          'An error occurred (AccessDenied)\n',
        );
      done(null, args.includes('json') ? '{"Account":"1"}' : 'text out\n', '');
    },
    'aws',
  );
  assert.deepEqual(await aws(['sts', 'get-caller-identity']), { Account: '1' });
  assert.equal(await aws(['ec2', 'x'], { json: false }), 'text out');
  await assert.rejects(
    aws(['ec2', 'fail']),
    /aws ec2 fail: An error occurred \(AccessDenied\)/,
  );
  assert.deepEqual(seen[0], [
    'aws',
    'sts',
    'get-caller-identity',
    '--profile',
    'gev-msfs',
    '--region',
    'us-east-1',
    '--output',
    'json',
  ]);
  assert.equal(
    await detectIp(async () => ({
      ok: true,
      text: async () => '203.0.113.7\n',
    })),
    '203.0.113.7/32',
  );
  await assert.rejects(
    detectIp(async () => ({ ok: false, status: 503 })),
    /503/,
  );
});

test('the AWS CLI found: on the PATH, else the MSI’s copy on Windows, else plain aws', () => {
  const msi = String.raw`C:\Program Files\Amazon\AWSCLIV2\aws.exe`;
  const env = {
    PATH: String.raw`C:\Windows\system32;C:\tools`,
    ProgramFiles: String.raw`C:\Program Files`,
  };
  const has =
    (...files) =>
    (file) =>
      files.includes(file);
  assert.equal(
    awsExecutable({
      platform: 'win32',
      env,
      exists: has(String.raw`C:\tools\aws.exe`, msi),
    }),
    'aws',
  );
  assert.equal(
    awsExecutable({ platform: 'win32', env, exists: has(msi) }),
    msi,
    'a shell opened before the install',
  );
  assert.equal(
    awsExecutable({ platform: 'win32', env: { Path: '' }, exists: has(msi) }),
    msi,
  );
  assert.equal(
    awsExecutable({ platform: 'win32', env, exists: has() }),
    'aws',
    'not installed: the error says so',
  );
  assert.equal(
    awsExecutable({ platform: 'linux', env, exists: has(msi) }),
    'aws',
  );
});
