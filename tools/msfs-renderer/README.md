# MSFS renderer (AWS)

A rented Windows GPU machine on AWS that runs Microsoft Flight Simulator
2024 as GEV's render farm. This PC computes a camera path from GEV's data;
the cloud machine flies the sim's add-on camera along it (SimConnect's
camera API) and records the video with OBS. Personal fork only.

Everything is driven from this PC with one script and the AWS CLI. Nothing
here needs the AWS console once an access key exists.

| File                  | What it is                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `template.yaml`       | CloudFormation: the security group, the instance role and the instance                               |
| `user-data.ps1`       | First boot: the NVIDIA gaming driver, Parsec, Steam, OBS, 7-Zip, one restart                         |
| `msfs.mjs`            | `deploy`, `start`, `stop`, `status`, `destroy`, `quota`                                              |
| `lib.mjs`             | Its pure parts (arguments, address, template, prices), tested in `src/tooling/msfsRenderer.test.mjs` |
| `airgpu-setup.ps1`    | AirGPU instead of AWS: Steam, OBS, 7-Zip, .NET 8 and the bridge, run by hand inside the machine      |
| `airgpu-smoke.ps1`    | AirGPU: a one-screen check of the GPU, Parsec, OBS's websocket, the bridge and the disk              |
| `airgpu-buildbox.ps1` | AirGPU as a temporary build runner for GEV's RAM-heavy data builds                                   |
| `airgpu-serve.mjs`    | Serves a build's zip once, to one address, for the trip back                                         |

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

   The MSI adds `aws.exe` to the machine's PATH, but shells opened before
   the install do not see it until they are reopened. When `aws` is not on
   the PATH, the scripts fall back to the MSI's location,
   `C:\Program Files\Amazon\AWSCLIV2\aws.exe`.

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
   request is open. The first time an account uses Service Quotas, AWS
   creates the service-linked role `AWSServiceRoleForServiceQuotas`, which
   is why the policy below allows `iam:CreateServiceLinkedRole` for that
   one role. Without it, the request fails with
   `DependencyAccessDeniedException` ("Service-linked role creation access
   denied"). Small increases are often approved automatically within
   minutes; others go to AWS support and take one to a few days. Run it again
   to see where the request stands. A `g5.4xlarge` would need 16.

### Minimum IAM policy

CloudFormation creates the resources with the caller's permissions, so the
user needs these, and nothing else. Replace every `<ACCOUNT_ID>` with your
12-digit account ID (`aws sts get-caller-identity --query Account --output
text --profile gev-msfs` prints it).

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
      "Resource": "arn:aws:cloudformation:*:<ACCOUNT_ID>:stack/gev-msfs-renderer/*"
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
        "arn:aws:iam::<ACCOUNT_ID>:role/gev-msfs-renderer/*",
        "arn:aws:iam::<ACCOUNT_ID>:instance-profile/gev-msfs-renderer/*"
      ]
    },
    {
      "Sid": "PassTheRoleToEc2",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::<ACCOUNT_ID>:role/gev-msfs-renderer/*",
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
    },
    {
      "Sid": "ServiceQuotasLinkedRole",
      "Effect": "Allow",
      "Action": "iam:CreateServiceLinkedRole",
      "Resource": "arn:aws:iam::<ACCOUNT_ID>:role/aws-service-role/servicequotas.amazonaws.com/AWSServiceRoleForServiceQuotas",
      "Condition": {
        "StringEquals": { "iam:AWSServiceName": "servicequotas.amazonaws.com" }
      }
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

1. **On this PC, the path.** A route becomes a camera path file, with
   terrain from the running app's DEM stack:

   ```bash
   npm run msfs:path -- --from lat,lon --to lat,lon [--via lat,lon] --out path.json
   ```

2. **On the cloud machine, the flight.** `bridge/` (C#, .NET 8) flies the
   sim's add-on camera along it through SimConnect's Camera API and records
   it with OBS:

   ```bash
   gev-bridge path.json --record
   ```

`bridge/README.md` has the build, the first run (`--check-header`,
`--attitude-test`), the OBS setup and the known risks.

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

## AirGPU (opportunistic)

The AWS account's GPU quota is still 0 vCPUs, so the same work can run on
a machine rented by the hour from AirGPU (airgpu.com). It is
opportunistic: only for what this PC cannot run (MSFS 2024 first, a
RAM-heavy build during a paid hour second), and nothing may assume the
machine is still there next time. Every script here is safe to run again
on a new machine.

**Tier:** Nvidia A10G, the same GPU as the AWS plan's `g5.2xlarge`, in US
East (N. Virginia), with the Windows image, which is Windows Server 2025. AirGPU supplies the NVIDIA driver and Parsec, so the scripts only
report them. We don't control the first boot: the user runs the scripts
once inside the machine.

On Server, the Windows Audio service is off and Media Foundation is an
optional feature. The setup turns on the first and installs the second,
which needs one restart; it says so at the end. Steam's `/S` and the .NET
installers' `/install /quiet /norestart` are the vendors' silent switches.
Their behaviour on Server 2025 was not tried here.

**What the user clicks at AirGPU:**

1. Create a machine on the A10G tier with the Windows image.
2. Give it enough disk for MSFS 2024: about 50 GB installed, plus Steam,
   OBS and the recordings. AirGPU sells storage as SSD add-ons in 50 GB
   steps from 100 GB. A disk kept between sessions is billed while the
   machine is off. The first machine has 250 GB, about 40 GB of it the
   OS, which leaves plenty.
3. Connect with Parsec.

**Cost:** pay by the hour, from credit bought in advance. The prices are in
the pricing section of AirGPU's site (https://airgpu.com/#pricing); none
are copied here.

### Run order (MSFS)

1. **Get the scripts.** Push the branch from this PC first
   (`git push fork local-fixes`), so the fork on GitHub has it. Then, in
   the machine, open PowerShell as administrator:

   ```powershell
   $base = 'https://raw.githubusercontent.com/doctutor/gods-eye-view/local-fixes/tools/msfs-renderer'
   foreach ($f in 'airgpu-setup.ps1', 'airgpu-smoke.ps1', 'airgpu-buildbox.ps1') { Invoke-WebRequest "$base/$f" -OutFile "C:\$f" -UseBasicParsing }
   ```

2. **Set up.** Run
   `powershell -ExecutionPolicy Bypass -File C:\airgpu-setup.ps1`. Its log
   is `C:\gev-provision.log`. It asks for nothing and stores no credential.
   Its steps:

   | Step                                                          | What it does                                                                                                            |
   | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
   | `NVIDIA driver (AirGPU supplies it; reported, not installed)` | Prints the GPU, the driver version and the memory (`nvidia-smi`)                                                        |
   | `Parsec (AirGPU supplies it; reported, not installed)`        | Prints Parsec's version and whether it runs                                                                             |
   | `Windows Audio service (Parsec streams the sound)`            | Starts the audio service, automatic from then on                                                                        |
   | `Media Foundation (Windows Server only)`                      | Installs the `Server-Media-Foundation` feature if it is missing; one restart                                            |
   | `Steam`                                                       | Installs Steam                                                                                                          |
   | `OBS Studio`                                                  | Installs OBS. Version 28 and later carry obs-websocket v5, which the bridge speaks; no separate plugin                  |
   | `7-Zip`                                                       | Installs 7-Zip                                                                                                          |
   | `.NET 8 (Desktop Runtime and SDK)`                            | Installs the .NET 8 Desktop Runtime and SDK from Microsoft's release metadata, each checked against its SHA-512         |
   | `GEV bridge`                                                  | Reads `bridge/` from the fork's branch (or `-BridgeSource DIR`) and publishes it framework-dependent to `C:\gev\bridge` |
   | `Camera path and recording folders`                           | Makes `C:\gev\paths` (camera paths go here) and `C:\gev\recordings`                                                     |
   | `Open Steam`                                                  | Opens Steam as the signed-in user, not elevated                                                                         |

   A step whose program is already installed skips the install. A failed
   step is logged and the rest go on; the summary lists the failures.

3. **Steam.** Sign in (Steam Guard) and install **Microsoft Flight
   Simulator 2024** from your library. The sign-in and the purchase are
   yours, in the Steam window.
4. **The SDK.** In the sim: Developer Mode on, then Help > SDK Installer.
   Run `airgpu-setup.ps1` again, so the bridge is built with
   `SimConnect.dll` beside it.
5. **OBS.** Tools > WebSocket Server Settings: enable the server (port 4455)
   and set a password. Put it in `$env:OBS_WEBSOCKET_PASSWORD` in the shell
   that runs the bridge (`bridge/README.md`, "OBS").
6. **Check.** `powershell -ExecutionPolicy Bypass -File C:\airgpu-smoke.ps1`
   prints one line each for `GPU`, `Parsec`, `OBS websocket`,
   `Bridge dry run` (a two-sample path through `--dry-run --fast`),
   `MSFS 2024 SDK` and `Disk`, as PASS, WARN or FAIL. It exits 1 on a FAIL
   and changes nothing.
7. **Fly.** Make the path on this PC with `npm run msfs:path` (its
   `--out path.json`) and copy the file into `C:\gev\paths`. Then run
   `C:\gev\bridge\gev-bridge.exe C:\gev\paths\path.json --record`, after
   the attitude test the first time (`bridge/README.md`).

The bridge is published framework-dependent: the Desktop Runtime is
installed anyway, and the SDK that builds it is on the machine. This PC
has no .NET SDK, so nothing is built here.

### Build box

`airgpu-buildbox.ps1` (from an elevated PowerShell, log
`C:\gev-buildbox.log`) turns the same machine into a temporary runner for
GEV's RAM-heavy data builds. The point is the 32 GB of RAM and a
datacenter's bandwidth for dump downloads. Its steps:

| Step            | What it does                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `Git`           | Installs Git for Windows (the latest release)                                                  |
| `Node.js 24`    | Installs the latest Node.js 24, this PC's major, checked against nodejs.org's `SHASUMS256.txt` |
| `GEV checkout`  | Clones `https://github.com/doctutor/gods-eye-view.git` at `local-fixes` into `C:\gev\repo`     |
| `npm ci`        | Installs the dependencies                                                                      |
| `Build folders` | Makes `C:\gev\raw`, `C:\gev\cache` and `C:\gev\out`                                            |

The fork is public, so the clone needs no token and nothing is signed in.
Push the branch first (`git push fork local-fixes`). Nothing goes up from
this PC: no `.env` and no key. So run only keyless builds there. The
Wikipedia points build needs no key. `--population` (Earth Engine's key
file and project) and the census build (`CENSUS_API_KEY`) do; run those on
this PC.

**The multi-wiki Wikipedia points build**, in a new PowerShell in
`C:\gev\repo`:

```powershell
$env:GEV_RAW_DIR = 'C:\gev\raw'
$env:WIKIPEDIA_COVERAGE_DIR = 'C:\gev\cache\wikipedia'
npm run wikipedia:build -- --points --wikis enwiki,dewiki,frwiki,eswiki,ruwiki,jawiki,zhwiki,itwiki,ptwiki,plwiki,nlwiki
```

The dumps land on the machine's disk and stay there. Only the result comes
back: `C:\gev\cache\wikipedia\points`.

**Bringing it back.** Run `airgpu-buildbox.ps1 -Package` to zip the points
into `C:\gev\out\wikipedia-points-<time>.zip` and print its SHA-256. Then
choose one:

- **Parsec's file transfer, if the session offers it.** This is the
  simplest. Whether AirGPU's Parsec allows it was not checked.
- **Otherwise, the one-shot server.** Run `airgpu-buildbox.ps1 -Serve`
  with the zip and `-AllowFrom` this PC's public IPv4. It opens TCP 8765 in
  the machine's Windows firewall to that one address and serves the zip
  once (`airgpu-serve.mjs`). The zip is at a random 32-hex-digit path and
  nowhere else. The server stops after one complete download or 30
  minutes, and the rule is removed when it stops. On this PC, run the
  `curl` line it prints and compare the SHA-256. It is plain HTTP, which
  is acceptable only because the points are built from Wikimedia's public
  dumps; never serve anything that needs a key this way. Whether AirGPU's
  own network lets the port through was not checked.

On this PC, unzip it into `.gev-cache/wikipedia/points` (or the
`WIKIPEDIA_COVERAGE_DIR` the server reads).

### Nothing persists

Treat every session as a new machine. Re-run the scripts; they skip what
is there. Copy back what you keep before the session ends, recordings
first, since they are the large files. Nothing in GEV depends on the
machine.

Not verified yet: none of this has run on an AirGPU machine. The scripts
parse (`src/tooling/airgpuScripts.test.mjs`), and the smoke script ran on
this PC, where it reported a GTX 1080 Ti as "not the A10G tier" and the
missing bridge as a FAIL.
