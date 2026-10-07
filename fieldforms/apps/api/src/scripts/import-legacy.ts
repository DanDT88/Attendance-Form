import ExcelJS from 'exceljs';
import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { createBlobStore } from '../lib/blobstore.js';
import { importLegacy } from '../services/legacy-import.js';

/**
 * Usage: DATABASE_URL=... pnpm import-legacy path/to/export.xlsx
 * Export the legacy Google Sheet with File > Download > Microsoft Excel (.xlsx).
 * Safe to run more than once; already-imported registers are skipped.
 */
const file = process.argv[2];
if (!file) {
  console.error('Usage: import-legacy <export.xlsx>');
  process.exit(1);
}

const cfg = loadConfig();
const { db } = createDb(cfg.DATABASE_URL);
const blobs = createBlobStore(cfg);
await blobs.ensureReady();
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);

try {
  const r = await importLegacy(db, wb, blobs);
  console.log('Legacy import reconciliation');
  console.log(`  Attendance rows read:     ${r.rowsRead}`);
  console.log(
    `  Registers imported:       ${r.registersImported} (+${r.endRegistersImported} end-of-shift)`,
  );
  console.log(`  Registers already there:  ${r.registersSkipped}`);
  console.log(`  Attendance entries:       ${r.entriesImported}`);
  console.log(`  Photos imported:          ${r.photosImported}`);
  console.log(
    `  Created: ${r.companiesCreated} companies, ${r.regionsCreated} regions, ${r.sitesCreated} sites, ${r.shiftsCreated} shifts, ${r.employeesCreated} employees`,
  );
  console.log(`  Rejected rows:            ${r.rejected.length}`);
  for (const x of r.rejected.slice(0, 200)) console.log(`    ${x.sheet} row ${x.row}: ${x.reason}`);
  if (r.rejected.length > 200) console.log(`    … and ${r.rejected.length - 200} more`);
  console.log(
    'Users and AdminUsers were not imported (plain-text passwords). Create accounts and PINs in Admin.',
  );
} finally {
  await db.destroy();
}
