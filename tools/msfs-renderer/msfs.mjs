#!/usr/bin/env node
// Personal fork: operate the GEV MSFS renderer, a rented AWS Windows GPU
// machine (template.yaml, README.md), through the AWS CLI v2 with the
// gev-msfs profile. Keys never enter the repository: the key pair's private
// key goes to ~/.gev-secrets/, and the Windows password is never fetched
// here (the command for it is printed). Not part of upstream God's Eye View.
//
//   node tools/msfs-renderer/msfs.mjs <deploy|start|stop|status|destroy|quota> [options]
//   npm run msfs:deploy | msfs:start | msfs:stop | msfs:status | msfs:quota
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  KEY_NAME,
  QUOTA,
  STACK,
  awsArgs,
  buildTemplate,
  costEstimate,
  money,
  parseArgs,
  parseCheckIp,
  pemPath,
  sessionHours,
  stackOutputs,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The AWS CLI as a function: (args, {json}) → parsed JSON or text. */
export function createAws(options, exec = execFile) {
  return (args, { json = true } = {}) =>
    new Promise((resolve, reject) => {
      exec(
        'aws',
        awsArgs(args, options, { json }),
        { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            const detail = String(stderr || error.message)
              .trim()
              .split('\n')
              .slice(-3)
              .join(' ');
            const failure = new Error(
              `aws ${args.slice(0, 2).join(' ')}: ${detail}`,
            );
            failure.stderr = String(stderr || '');
            return reject(failure);
          }
          const text = String(stdout).trim();
          if (!json) return resolve(text);
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch {
            resolve(text);
          }
        },
      );
    });
}

/** The caller's public IPv4, from AWS's own address echo. */
export async function detectIp(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl('https://checkip.amazonaws.com', {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`checkip.amazonaws.com answered ${response.status}`);
  return parseCheckIp(await response.text());
}

async function stackOrNull(ctx) {
  try {
    return await ctx.aws([
      'cloudformation',
      'describe-stacks',
      '--stack-name',
      STACK,
    ]);
  } catch (error) {
    if (/does not exist/.test(error.stderr || error.message)) return null;
    throw error;
  }
}

async function instanceOf(ctx) {
  const stack = await stackOrNull(ctx);
  if (!stack)
    throw new Error(
      `no stack ${STACK} in ${ctx.options.region}: run npm run msfs:deploy`,
    );
  const outputs = stackOutputs(stack);
  const answer = await ctx.aws([
    'ec2',
    'describe-instances',
    '--instance-ids',
    outputs.InstanceId,
  ]);
  const instance = answer?.Reservations?.[0]?.Instances?.[0];
  if (!instance) throw new Error(`instance ${outputs.InstanceId} not found`);
  const parameter = (key) =>
    stack?.Stacks?.[0]?.Parameters?.find((p) => p.ParameterKey === key)
      ?.ParameterValue;
  const rootGb = Number(parameter('RootVolumeGb')) || ctx.options.rootGb;
  return { stack, outputs, instance, rootGb };
}

/** The key pair in AWS, its private key under ~/.gev-secrets: made once. */
async function ensureKeyPair(ctx) {
  const file = pemPath(ctx.home);
  let exists = true;
  try {
    await ctx.aws(['ec2', 'describe-key-pairs', '--key-names', KEY_NAME]);
  } catch (error) {
    if (!/InvalidKeyPair\.NotFound/.test(error.stderr || error.message))
      throw error;
    exists = false;
  }
  if (exists) {
    if (!ctx.files.exists(file))
      throw new Error(
        `the key pair ${KEY_NAME} exists in AWS but its private key is not at ${file}; ` +
          'AWS keeps no copy. Put it back there, or delete the key pair (aws ec2 delete-key-pair --key-name ' +
          `${KEY_NAME}) and deploy again (the Windows password can then only be read with the new key after a new instance).`,
      );
    return file;
  }
  const material = await ctx.aws(
    [
      'ec2',
      'create-key-pair',
      '--key-name',
      KEY_NAME,
      '--key-type',
      'rsa',
      '--key-format',
      'pem',
      '--tag-specifications',
      `ResourceType=key-pair,Tags=[{Key=Project,Value=${STACK}}]`,
      '--query',
      'KeyMaterial',
      '--output',
      'text',
    ],
    { json: false },
  );
  ctx.files.writeSecret(file, `${String(material).trim()}\n`);
  ctx.log(
    `Created the key pair ${KEY_NAME}; its private key is at ${file} (not in the repository).`,
  );
  return file;
}

function passwordCommand(ctx, instanceId) {
  const { profile, region } = ctx.options;
  return `aws ec2 get-password-data --instance-id ${instanceId} --priv-launch-key "${pemPath(ctx.home)}" --profile ${profile} --region ${region} --query PasswordData --output text`;
}

function printAccess(ctx, instance) {
  const ip = instance.PublicIpAddress;
  ctx.log(
    `Instance ${instance.InstanceId} (${instance.InstanceType}): ${instance.State?.Name}${ip ? `, public IP ${ip}` : ''}`,
  );
  if (ip) {
    ctx.log(`  RDP:    mstsc /v:${ip}   (user Administrator)`);
    ctx.log(
      `  Parsec: the machine appears in your Parsec app once you have signed in on it`,
    );
  }
  ctx.log(
    `  Windows password (run it yourself; prints the password): ${passwordCommand(ctx, instance.InstanceId)}`,
  );
}

export const commands = {
  async deploy(ctx) {
    const { options } = ctx;
    const identity = await ctx.aws(['sts', 'get-caller-identity']);
    ctx.log(
      `AWS account ${identity.Account}, ${options.region}, profile ${options.profile}`,
    );
    const cidr = options.ip || (await detectIp(ctx.fetch));
    ctx.log(`RDP and Parsec open to ${cidr} only`);
    await ensureKeyPair(ctx);
    const template = buildTemplate(
      ctx.files.read(path.join(HERE, 'template.yaml')),
      ctx.files.read(path.join(HERE, 'user-data.ps1')),
    );
    const templateFile = ctx.files.writeTemp(
      'gev-msfs-renderer.template.yaml',
      template,
    );
    await ctx.aws(
      [
        'cloudformation',
        'deploy',
        '--stack-name',
        STACK,
        '--template-file',
        templateFile,
        '--capabilities',
        'CAPABILITY_IAM',
        '--parameter-overrides',
        `KeyName=${KEY_NAME}`,
        `AllowedCidr=${cidr}`,
        `InstanceType=${options.instanceType}`,
        `RootVolumeGb=${options.rootGb}`,
        '--tags',
        `Project=${STACK}`,
        '--no-fail-on-empty-changeset',
      ],
      { json: false },
    );
    const { instance } = await instanceOf(ctx);
    printAccess(ctx, instance);
    ctx.log(
      'First boot installs the driver, Parsec, Steam, OBS and 7-Zip, then restarts once: allow about 30 minutes. Its log is C:\\gev-provision.log.',
    );
    ctx.log(
      'The password needs about 4 minutes after the first launch. Then the manual steps: tools/msfs-renderer/README.md.',
    );
  },

  async start(ctx) {
    const { outputs, instance } = await instanceOf(ctx);
    // A new address at home: the security group follows it.
    const cidr = ctx.options.ip || (await detectIp(ctx.fetch));
    if (outputs.AllowedCidr && outputs.AllowedCidr !== cidr) {
      ctx.log(
        `Your address changed (${outputs.AllowedCidr} → ${cidr}): updating the security group`,
      );
      await ctx.aws([
        'cloudformation',
        'update-stack',
        '--stack-name',
        STACK,
        '--use-previous-template',
        '--capabilities',
        'CAPABILITY_IAM',
        '--parameters',
        'ParameterKey=KeyName,UsePreviousValue=true',
        `ParameterKey=AllowedCidr,ParameterValue=${cidr}`,
        'ParameterKey=InstanceType,UsePreviousValue=true',
        'ParameterKey=ImageId,UsePreviousValue=true',
        'ParameterKey=RootVolumeGb,UsePreviousValue=true',
      ]);
      await ctx.aws(
        [
          'cloudformation',
          'wait',
          'stack-update-complete',
          '--stack-name',
          STACK,
        ],
        { json: false },
      );
    }
    if (instance.State?.Name !== 'running') {
      await ctx.aws([
        'ec2',
        'start-instances',
        '--instance-ids',
        instance.InstanceId,
      ]);
      await ctx.aws(
        [
          'ec2',
          'wait',
          'instance-running',
          '--instance-ids',
          instance.InstanceId,
        ],
        { json: false },
      );
    }
    const { instance: now } = await instanceOf(ctx);
    printAccess(ctx, now);
    ctx.log(
      `Billing: ${money(costEstimate({ instanceType: now.InstanceType, hours: 1 }).hourly)}/h while running. Stop it with npm run msfs:stop.`,
    );
  },

  async stop(ctx) {
    const { instance, rootGb } = await instanceOf(ctx);
    if (instance.State?.Name === 'stopped')
      return ctx.log(`${instance.InstanceId} is already stopped.`);
    await ctx.aws([
      'ec2',
      'stop-instances',
      '--instance-ids',
      instance.InstanceId,
    ]);
    await ctx.aws(
      [
        'ec2',
        'wait',
        'instance-stopped',
        '--instance-ids',
        instance.InstanceId,
      ],
      { json: false },
    );
    ctx.log(
      `${instance.InstanceId} stopped. Only its ${rootGb} GB volume is billed now (the local NVMe disk is erased on stop).`,
    );
  },

  async status(ctx) {
    const { instance, rootGb } = await instanceOf(ctx);
    const state = instance.State?.Name;
    if (state === 'running') {
      const hours = sessionHours(instance.LaunchTime, ctx.now());
      const cost = costEstimate({
        instanceType: instance.InstanceType,
        hours,
        rootGb,
        gbOut: ctx.options.gbOut,
      });
      printAccess(ctx, instance);
      ctx.log(
        `  This session: ${hours.toFixed(2)} h since ${instance.LaunchTime}, about ${money(cost.total)} (compute ${money(cost.compute)}, public IPv4 ${money(cost.ipv4)}, volume ${money(cost.storage)}${ctx.options.gbOut ? `, transfer ${money(cost.transfer)}` : ''}); ${money(cost.hourly)}/h from here`,
      );
      ctx.log(
        `  Volume: ${money(cost.storageMonth)}/month whether running or not.`,
      );
    } else {
      const cost = costEstimate({
        instanceType: instance.InstanceType,
        hours: 0,
        rootGb,
      });
      ctx.log(
        `Instance ${instance.InstanceId} (${instance.InstanceType}): ${state}. Billed now: the ${rootGb} GB volume, ${money(cost.storageMonth)}/month.`,
      );
    }
  },

  async destroy(ctx) {
    const { instance, rootGb } = await instanceOf(ctx);
    let typed = ctx.options.confirm;
    if (typed === null)
      typed = await ctx.prompt(
        `This deletes ${STACK}: the instance, its ${rootGb} GB volume (MSFS and all) and the security group. Type ${STACK} to go on: `,
      );
    if (String(typed).trim() !== STACK) {
      ctx.log('Not confirmed; nothing deleted.');
      return;
    }
    await ctx.aws([
      'ec2',
      'modify-instance-attribute',
      '--instance-id',
      instance.InstanceId,
      '--no-disable-api-termination',
    ]);
    await ctx.aws(['cloudformation', 'delete-stack', '--stack-name', STACK]);
    await ctx.aws(
      [
        'cloudformation',
        'wait',
        'stack-delete-complete',
        '--stack-name',
        STACK,
      ],
      { json: false },
    );
    ctx.log(
      `${STACK} deleted. The key pair ${KEY_NAME} and ${pemPath(ctx.home)} are kept for a later deploy (aws ec2 delete-key-pair --key-name ${KEY_NAME} removes it).`,
    );
  },

  async quota(ctx) {
    const ids = [
      '--service-code',
      QUOTA.serviceCode,
      '--quota-code',
      QUOTA.quotaCode,
    ];
    let current;
    try {
      current = (await ctx.aws(['service-quotas', 'get-service-quota', ...ids]))
        ?.Quota?.Value;
    } catch (error) {
      if (!/NoSuchResource/.test(error.stderr || error.message)) throw error;
      current = (
        await ctx.aws([
          'service-quotas',
          'get-aws-default-service-quota',
          ...ids,
        ])
      )?.Quota?.Value;
    }
    ctx.log(
      `${QUOTA.name} (${QUOTA.quotaCode}) in ${ctx.options.region}: ${current ?? '?'} vCPUs (a ${ctx.options.instanceType} needs ${vcpus(ctx.options.instanceType)})`,
    );
    if (Number(current) >= QUOTA.desired)
      return ctx.log('Enough: nothing to request.');
    const history = await ctx.aws([
      'service-quotas',
      'list-requested-service-quota-change-history-by-quota',
      ...ids,
    ]);
    const open = (history?.RequestedQuotas || []).find((r) =>
      ['PENDING', 'CASE_OPENED'].includes(r.Status),
    );
    if (open)
      return ctx.log(
        `A request for ${open.DesiredValue} is ${open.Status} (${open.Id}, since ${open.Created}). AWS usually answers within a day or two.`,
      );
    const answer = await ctx.aws([
      'service-quotas',
      'request-service-quota-increase',
      ...ids,
      '--desired-value',
      String(QUOTA.desired),
    ]);
    const request = answer?.RequestedQuota;
    ctx.log(
      `Requested ${QUOTA.desired} vCPUs: ${request?.Status ?? '?'} (${request?.Id ?? '?'}). Check again with npm run msfs:quota.`,
    );
  },
};

const vcpus = (type) =>
  ({ 'g5.xlarge': 4, 'g5.2xlarge': 8, 'g5.4xlarge': 16 })[type] ?? '?';

function realContext(options) {
  return {
    options,
    aws: createAws(options),
    fetch: globalThis.fetch,
    home: os.homedir(),
    now: () => Date.now(),
    log: (line) => console.log(line),
    prompt: async (question) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    files: {
      exists: (file) => fs.existsSync(file),
      read: (file) => fs.readFileSync(file, 'utf8'),
      writeTemp: (name, text) => {
        const file = path.join(os.tmpdir(), name);
        fs.writeFileSync(file, text);
        return file;
      },
      writeSecret: (file, text) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
        // Windows ignores the mode: only this user may read it.
        if (process.platform === 'win32')
          execFile(
            'icacls',
            [file, '/inheritance:r', '/grant:r', `${os.userInfo().username}:R`],
            () => {},
          );
      },
    },
  };
}

export async function main(
  argv = process.argv.slice(2),
  makeContext = realContext,
) {
  const options = parseArgs(argv);
  await commands[options.command](makeContext(options));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href)
  main().catch((error) => {
    console.error(`[msfs] ${error?.message || error}`);
    process.exitCode = 1;
  });
