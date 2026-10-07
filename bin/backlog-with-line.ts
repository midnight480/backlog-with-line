#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { BacklogWithLineStack } from '../lib/backlog-with-line-stack';

const app = new cdk.App();
new BacklogWithLineStack(app, 'BacklogWithLineStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-northeast-1',
  },
});
