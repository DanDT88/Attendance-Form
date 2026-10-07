import type { ConnectionKind, DestinationKind } from '@fieldforms/shared';
import { emailAdapter } from './adapters/email.js';
import { googleDriveAdapter } from './adapters/google-drive.js';
import { googleSheetsAdapter } from './adapters/google-sheets.js';
import { onedriveAdapter } from './adapters/onedrive.js';
import { s3Adapter } from './adapters/s3.js';
import { sftpAdapter } from './adapters/sftp.js';
import { slackAdapter } from './adapters/slack.js';
import { sqlAdapter } from './adapters/sql.js';
import { webhookAdapter } from './adapters/webhook.js';
import { googleDriver } from './connections/google.js';
import { microsoftDriver } from './connections/microsoft.js';
import { s3Driver } from './connections/s3.js';
import { sftpDriver } from './connections/sftp.js';
import { slackDriver } from './connections/slack.js';
import { sqlDriver } from './connections/sql.js';
import { webhookDriver } from './connections/webhook.js';
import type { ConnectionDriver, DestinationAdapter } from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- each adapter has its own settings type */
export const ADAPTERS: Record<DestinationKind, DestinationAdapter<any, any>> = {
  email: emailAdapter,
  webhook: webhookAdapter,
  sftp: sftpAdapter,
  s3: s3Adapter,
  google_drive: googleDriveAdapter,
  onedrive: onedriveAdapter,
  slack: slackAdapter,
  sql: sqlAdapter,
  google_sheets: googleSheetsAdapter,
};

export const DRIVERS: Record<ConnectionKind, ConnectionDriver<any>> = {
  webhook: webhookDriver,
  sftp: sftpDriver,
  s3: s3Driver,
  google: googleDriver,
  microsoft: microsoftDriver,
  slack: slackDriver,
  sql: sqlDriver,
};
