/**
 * Shared configuration for the Attendance Platform front ends.
 *
 * This is the single source of truth for the Apps Script Web App URL. Loaded by
 * admin.html via <script src="./config.js">.
 *
 * NOTE: index.html and sw.js still carry their own hardcoded copies of this URL,
 * and they point at two DIFFERENT deployments of the same script project. Both
 * are live and both reach the same spreadsheet today, so nothing is broken — but
 * they are separate deployments, so publishing a new version to one and not the
 * other will silently leave the second running old code. Worth consolidating
 * onto this file.
 */
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzf_erZFTST-MS2LzWtT2Fy3odL5Pbvud8-jfaaWfKj52w5z-qyWRMt9OuzPMpXUjpfIg/exec";
