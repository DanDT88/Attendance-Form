/**
 * Shared configuration for the Attendance Platform front ends.
 *
 * The single source of truth for the Apps Script Web App URL. Loaded by
 * index.html and admin.html with a <script> tag, and by sw.js via
 * importScripts — so there is exactly one place this is defined.
 *
 * WHICH BACKEND GETS USED IS DECIDED BY HOSTNAME, not by editing this file:
 *
 *   hr940.github.io      -> PRODUCTION  (the live app and the real spreadsheet)
 *   anything else        -> TEST        (the fork's Pages site, and localhost)
 *
 * That is deliberate. The alternative — pointing this file at the test backend
 * while testing and remembering to point it back before release — is one
 * forgotten edit away from the live app writing into the test sheet, or worse,
 * a test build writing into production. Deciding by hostname makes that class
 * of mistake impossible, and means the same commit can be merged to main
 * without touching a line.
 *
 * Both URLs are separate deployments of the same Code.gs. TEST is a standalone
 * project with SPREADSHEET_ID_OVERRIDE set to the copied spreadsheet.
 */

/** Live: the real spreadsheet, real emails, real staff. */
const APPS_SCRIPT_URL_PROD = "https://script.google.com/macros/s/AKfycbzf_erZFTST-MS2LzWtT2Fy3odL5Pbvud8-jfaaWfKj52w5z-qyWRMt9OuzPMpXUjpfIg/exec";

/** Staging: the copied spreadsheet. Safe to write to. */
const APPS_SCRIPT_URL_TEST = "https://script.google.com/macros/s/AKfycbz20sPWyL_jYObFMX9AvizPYVaKWwg4gHEW07JlgchgW5dF2JSnEnwXm2ly8bozz38jrw/exec";

/** The production host. Everything else is treated as staging. */
const PROD_HOSTNAME = "hr940.github.io";

// `location` is defined both in a page and in a service worker, so this same
// expression works for index.html, admin.html and sw.js alike.
const APPS_SCRIPT_URL = (location.hostname === PROD_HOSTNAME)
  ? APPS_SCRIPT_URL_PROD
  : APPS_SCRIPT_URL_TEST;
