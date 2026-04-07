#!/usr/bin/env bun

import { deployToRailway, redeployToRailway, changeBranch } from './api/railway';

interface CliArgs {
  command: string;
  options: {
    project?: string;
    service?: string;
    environment?: string;
    branch?: string;
    repo?: string;
    token?: string;
    config?: string;
  };
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  
  const options: CliArgs['options'] = {};
  
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.replace('--', '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const value = args[i + 1];
      if (value && !value.startsWith('--')) {
        (options as Record<string, string>)[key] = value;
        i++;
      } else {
        (options as Record<string, string>)[key] = 'true';
      }
    }
  }
  
  return { command, options };
}

async function deploy(options: CliArgs['options']) {
  const token = options.token || process.env.RAILWAY_TOKEN;
  if (!token) {
    console.error('Error: Railway token required. Use --token or RAILWAY_TOKEN env var');
    process.exit(1);
  }
  
  if (!options.project || !options.service) {
    console.error('Error: --project and --service are required');
    process.exit(1);
  }
  
  console.log(`Deploying ${options.service} to project ${options.project}...`);
  
  try {
    const deploymentId = await deployToRailway(token, {
      name: options.service,
      projectId: options.project,
      serviceId: options.service,
      environmentId: options.environment,
      repo: options.repo,
      branch: options.branch,
    });
    
    console.log(`Deployment triggered! ID: ${deploymentId}`);
  } catch (error) {
    console.error(`Deployment failed: ${error}`);
    process.exit(1);
  }
}

async function redeploy(options: CliArgs['options']) {
  const token = options.token || process.env.RAILWAY_TOKEN;
  if (!token) {
    console.error('Error: Railway token required. Use --token or RAILWAY_TOKEN env var');
    process.exit(1);
  }
  
  if (!options.service) {
    console.error('Error: --service is required');
    process.exit(1);
  }
  
  console.log(`Redeploying ${options.service}...`);
  
  try {
    const deploymentId = await redeployToRailway(token, options.service, options.environment);
    console.log(`Redeployment triggered! ID: ${deploymentId}`);
  } catch (error) {
    console.error(`Redeploy failed: ${error}`);
    process.exit(1);
  }
}

async function setBranch(options: CliArgs['options']) {
  const token = options.token || process.env.RAILWAY_TOKEN;
  if (!token) {
    console.error('Error: Railway token required. Use --token or RAILWAY_TOKEN env var');
    process.exit(1);
  }
  
  if (!options.service || !options.branch || !options.repo) {
    console.error('Error: --service, --branch, and --repo are required');
    process.exit(1);
  }
  
  console.log(`Changing branch to ${options.branch} for ${options.service}...`);
  
  try {
    await changeBranch(token, options.service, options.repo, options.branch);
    console.log(`Branch changed to ${options.branch}`);
    
    console.log('Triggering deployment...');
    const deploymentId = await redeployToRailway(token, options.service, options.environment);
    console.log(`Deployment triggered! ID: ${deploymentId}`);
  } catch (error) {
    console.error(`Failed: ${error}`);
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
Railway Deployer CLI

Usage:
  railway-deploy <command> [options]

Commands:
  deploy         Deploy a service to Railway
  redeploy      Redeploy an existing service
  set-branch    Change deployment branch and redeploy
  help          Show this help message

Options:
  --token        Railway API token
  --project      Railway project ID
  --service      Railway service ID
  --environment  Railway environment ID (default: production)
  --branch       Git branch to connect before deploy
  --repo         GitHub repository for branch connection (format: username/repo)

Examples:
  railway-deploy deploy --project proj_xxx --service svc_xxx --branch main
  railway-deploy redeploy --service svc_xxx
  railway-deploy set-branch --service svc_xxx --repo user/repo --branch develop

Environment Variables:
  RAILWAY_TOKEN  Railway API token
`);
}

async function main() {
  const { command, options } = parseArgs();
  
  switch (command) {
    case 'deploy':
      await deploy(options);
      break;
    case 'redeploy':
      await redeploy(options);
      break;
    case 'set-branch':
    case 'setBranch':
      await setBranch(options);
      break;
    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;
    default:
      console.log(`Unknown command: ${command}`);
      showHelp();
      process.exit(1);
  }
}

main();
