# MSFS renderer (AWS)

A rented Windows GPU machine on AWS that runs Microsoft Flight Simulator
2024 as GEV's render farm. This PC computes a camera path from GEV's data;
the cloud machine flies the sim's add-on camera along it (SimConnect's
camera API) and records the video with OBS. Personal fork only.

Everything is driven from this PC with one script and the AWS CLI. Nothing
here needs the AWS console once an access key exists.

| File            | What it is                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `template.yaml` | CloudFormation: the security group, the instance role and the instance                               |
| `user-data.ps1` | First boot: the NVIDIA gaming driver, Parsec, Steam, OBS, 7-Zip, one restart                         |
| `msfs.mjs`      | `deploy`, `start`, `stop`, `status`, `destroy`, `quota`                                              |
| `lib.mjs`       | Its pure parts (arguments, address, template, prices), tested in `src/tooling/msfsRenderer.test.mjs` |

## What gets built

- **One instance:** `g5.2xlarge` (8 vCPUs, 32 GiB, one NVIDIA A10G with 24 GB,
  a 450 GB local NVMe disk). It runs the latest Windows Server 2022 English
  Full Base AMI (the SSM public parameter
  `/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base`).
- **Storage:** a 150 GB gp3 system volume, encrypted. us-east-1 by default
  (`--region`).
- **Protection:** termination protection is on, and a shutdown from inside
  Windows stops the instance rather than terminating it. The scripts start and
  stop it; only `destroy` deletes it.
- **Security group:** RDP (TCP 3389) and Parsec (TCP and UDP 8000-8010), open to
  one address only, the caller's public IPv4 as a /32. `start` follows the
  address when it changes.
- **Instance role:** `AmazonSSMManagedInstanceCore`, and read access to
  `nvidia-gaming` (the gaming driver for G5, per AWS's documented Windows
  procedure) and `ec2-windows-nvidia-drivers` (the GRID driver, should the
  gaming one not suit).
- **Tags:** everything is tagged `gev-msfs-renderer`.
- **Key pair:** `gev-msfs-renderer` (RSA, for the Windows password). Its private
  key is kept at `~/.gev-secrets/gev-msfs-renderer.pem`, readable by this user
  only, and never in the repository. AWS keeps no copy.

## Prerequisites

1. **AWS CLI v2.** Install it with the MSI from
   `https://awscli.amazonaws.com/AWSCLIV2.msi`, then check it:

   ```bash
   aws --version
   ```

2. **An IAM user** for these scripts, with only the policy below. Create it
   in the console once, or have an administrator do it. It is the account's
   only console step.
3. **An access key** for that user, in `~/.aws/credentials` under the profile
   `gev-msfs`:

   ```ini
   [gev-msfs]
   aws_access_key_id = AKIA...
   aws_secret_access_key = ...
   ```

   The scripts pass `--profile gev-msfs --region us-east-1` on every call,
   and never read or print the key.

4. **The GPU quota.** "Running On-Demand G and VT instances" (`L-DB2E81BA`)
   is 0 vCPUs on a new account, and a `g5.2xlarge` needs 8.

   ```bash
   npm run msfs:quota
   ```

   It reports the current value and requests 8 if it is lower and no
   request is open. Small increases are often approved automatically within
   minutes; others go to AWS support and take one to a few days. Run it again
   to see where the request stands. A `g5.4xlarge` would need 16.

### Minimum IAM policy

CloudFormation creates the resources with the caller's permissions, so the
user needs these, and nothing else. Account 654527450351.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TheStack",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResources",
        "cloudformation:GetTemplate",
        "cloudformation:CreateChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet"
      ],
      "Resource": "arn:aws:cloudformation:*:654527450351:stack/gev-msfs-renderer/*"
    },
    {
      "Sid": "TemplateChecks",
      "Effect": "Allow",
      "Action": [
        "cloudformation:ValidateTemplate",
        "cloudformation:GetTemplateSummary"
      ],
      "Resource": "*"
    },
    {
      "Sid": "TheMachine",
      "Effect": "Allow",
      "Action": [
        "ec2:Describe*",
        "ec2:RunInstances",
        "ec2:StartInstances",
        "ec2:StopInstances",
        "ec2:TerminateInstances",
        "ec2:ModifyInstanceAttribute",
        "ec2:GetPasswordData",
        "ec2:CreateTags",
        "ec2:CreateSecurityGroup",
        "ec2:DeleteSecurityGroup",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:RevokeSecurityGroupIngress",
        "ec2:CreateKeyPair",
        "ec2:DeleteKeyPair"
      ],
      "Resource": "*"
    },
    {
      "Sid": "TheInstanceRole",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:PutRolePolicy",
        "iam:GetRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:CreateInstanceProfile",
        "iam:DeleteInstanceProfile",
        "iam:GetInstanceProfile",
        "iam:AddRoleToInstanceProfile",
        "iam:RemoveRoleFromInstanceProfile"
      ],
      "Resource": [
        "arn:aws:iam::654527450351:role/gev-msfs-renderer/*",
        "arn:aws:iam::654527450351:instance-profile/gev-msfs-renderer/*"
      ]
    },
    {
      "Sid": "PassTheRoleToEc2",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::654527450351:role/gev-msfs-renderer/*",
      "Condition": {
        "StringEquals": { "iam:PassedToService": "ec2.amazonaws.com" }
      }
    },
    {
      "Sid": "TheWindowsAmi",
      "Effect": "Allow",
      "Action": "ssm:GetParameters",
      "Resource": "arn:aws:ssm:*::parameter/aws/service/ami-windows-latest/*"
    },
    {
      "Sid": "TheGpuQuota",
      "Effect": "Allow",
      "Action": [
        "servicequotas:GetServiceQuota",
        "servicequotas:GetAWSDefaultServiceQuota",
        "servicequotas:ListRequestedServiceQuotaChangeHistoryByQuota",
        "servicequotas:RequestServiceQuotaIncrease"
      ],
      "Resource": "*"
    }
  ]
}
```

The role and its instance profile live under the IAM path
`/gev-msfs-renderer/`, so the `iam:` actions cannot touch any other role.
The EC2 actions are not scoped by resource: EC2 creates new IDs on every
run, so tag conditions would be the only way, and they would need one rule
per action.

## Cost

us-east-1 prices, USD. Instances: Windows On-Demand, from AWS's public price
data (published 2026-10-15). Transfer out and public IPv4: AWS's price list
(2026-09-16 and 2026-10-16). gp3: the EBS pricing page.

| Item                             | Price                                                             | When                             |
| -------------------------------- | ----------------------------------------------------------------- | -------------------------------- |
| `g5.2xlarge`, Windows, On-Demand | $1.58 per hour                                                    | while running                    |
| (`g5.xlarge` / `g5.4xlarge`)     | ($1.19 / $2.36 per hour)                                          | (`--instance-type`)              |
| Public IPv4 address              | $0.005 per hour                                                   | while running (released on stop) |
| 150 GB gp3 volume                | $0.08 per GB-month = $12.00 per month                             | always, until `destroy`          |
| Data transfer out                | the first 100 GB per month free (account-wide), then $0.09 per GB | when videos are downloaded       |

Examples:

- **A 4-hour session:** $6.34, plus the volume's $12 per month.
- **A month with 20 hours:** $31.70 + $12 = about $44.
- **Video:** 1080p60 recorded at 50 Mbit/s is 22.5 GB per hour of footage.
  Downloading it costs nothing within the monthly 100 GB, then about $2 per
  hour of footage.
- **`npm run msfs:status`** shows the running session's estimate
  (`--gb-out N` adds transfer).

The instance's 450 GB NVMe disk is free and fast but erased on every stop.
Record to it, then copy what you keep to the gp3 volume or download it.

## Commands

```bash
npm run msfs:deploy
```

`deploy` creates or updates the stack:

- It checks the account (`sts get-caller-identity`).
- It finds this PC's public address (checkip.amazonaws.com; `--ip` overrides).
- It creates the key pair if it is missing, with the private key going to
  `~/.gev-secrets`.
- It fills `template.yaml`'s UserData from `user-data.ps1` and runs
  `aws cloudformation deploy`.

It then prints the instance's public IP, the RDP command, and the command
that decrypts the Windows password with the `.pem`. It does not fetch the
password itself. The password is ready about 4 minutes after the first
launch; first-boot provisioning takes about 30 minutes, including its one
restart.

```bash
npm run msfs:start
```

`start` starts the instance. If this PC's address has changed, it updates
the security group first.

```bash
npm run msfs:stop
```

`stop` stops the instance and waits until it has stopped. Only the volume is
billed then.

```bash
npm run msfs:status
```

`status` shows the state, the public IP, the hours this session and its cost
so far.

```bash
npm run msfs:quota
```

`quota` reports the GPU quota and requests 8 vCPUs if needed (see
Prerequisites).

```bash
node tools/msfs-renderer/msfs.mjs destroy
```

`destroy` asks you to type `gev-msfs-renderer` (or pass `--confirm
gev-msfs-renderer`). It then lifts termination protection and deletes the
stack: the instance, its volume (MSFS and all) and the security group. The
key pair and its `.pem` stay for a later deploy. There is deliberately no
npm script for it.

All commands take `--region` and `--profile`. `deploy` also takes
`--instance-type`, `--root-gb` and `--ip`.

## First session (by hand, once)

`C:\gev-provision.log` lists each provisioning step and says which ones
failed. After the restart, it also shows the NVIDIA licence ("Product Name:
NVIDIA Cloud Gaming", "License Status: Licensed").

1. **Sign in with RDP once.** Run the password command `deploy` printed, then
   `mstsc /v:<ip>` as `Administrator`. Read `C:\gev-provision.log`.
2. **Parsec.** Open Parsec (installed as a shared host) and sign in with your
   Parsec account. From then on, connect from this PC with Parsec, not RDP.
   RDP's display has no GPU behind it, and the sim needs one.
3. **Steam.** Sign in (Steam Guard), and install **Microsoft Flight Simulator
   2024** (Standard) from your library. Let it download its base content to
   the gp3 volume.
4. **Developer Mode.** In the sim: Options > General Options > Developers >
   Developer Mode on.
5. **The SDK.** From the Developer Mode menu, use Help > SDK Installer to
   download and install the MSFS 2024 SDK. It holds SimConnect, which the
   bridge program uses.
6. **Stop the machine** when done: `npm run msfs:stop`.

## Record a camera path

Placeholder: a bridge program (a separate task) will run on the cloud
machine. It will take a camera path computed here from GEV's data, fly the
sim's add-on camera along it through SimConnect's Camera API, and start and
stop OBS around it.

## Not verified yet

Nothing here has called AWS, and these are the open points:

- **Validation.** CloudFormation has not validated `template.yaml`. The first
  `deploy` is the test; `aws cloudformation validate-template` checks it
  without creating anything.
- **NVIDIA installer.** It is run with `-s -noreboot -clean` (NVIDIA's usual
  silent flags), and the script picks the file whose name has `server2022`.
  If the log shows the driver step failed, run the installer from
  `C:\gev-provision\NVIDIA` by hand. Then set the registry value and copy
  the certificate as the log's commands show.
- **MSFS 2024 on Windows Server 2022.** It is sold for Windows 10 and 11, and
  running it on Windows Server is untested here. If it refuses, the fallback
  is the GRID driver (already readable by the instance role) or another
  instance setup.
- **Parsec flags.** Its `/silent /shared` flags come from Parsec's own Cloud
  Preparation Tool. Parsec's documentation page was not reachable.
- **gp3 price.** The EBS pricing page gives $0.08 per GB-month without naming
  us-east-1.
