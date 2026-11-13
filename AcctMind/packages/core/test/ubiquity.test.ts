import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CK_ENVIRONMENT, CK_FIELD, CK_RECORD_NAME, CK_RECORD_TYPE,
  STORE_FILE, UBIQUITY_CONTAINER, ubiquityFolder, ubiquityPath,
} from '../src/index';

/**
 * Where the shared file lives.
 *
 * Small, and worth having anyway: the entitlement names the container with
 * dots and the filesystem names the same container with tildes, and those
 * two spellings sitting in two different files is exactly how a sync that
 * "works" writes to a folder nobody reads.
 */
describe('the ubiquity container', () => {
  it('turns every dot into a tilde, which is Apple\'s own spelling', () => {
    expect(ubiquityFolder('iCloud.com.seancheren.acctmind'))
      .toBe('iCloud~com~seancheren~acctmind');
    // Every one of them, not just the first — a `replace` without /g is the
    // way this goes wrong, and it goes wrong silently.
    expect(ubiquityFolder('a.b.c.d')).toBe('a~b~c~d');
  });

  it('is the same container the entitlements ask for', () => {
    // app.config.js writes this string into four entitlement keys. If the
    // two ever part, the app has a container it cannot reach and a folder
    // nothing writes to, and neither end reports a thing.
    expect(UBIQUITY_CONTAINER).toBe('iCloud.com.seancheren.acctmind');
    expect(ubiquityFolder()).toBe('iCloud~com~seancheren~acctmind');
  });

  it('builds the Mac path under Mobile Documents', () => {
    expect(ubiquityPath('/Users/alice'))
      .toBe('/Users/alice/Library/Mobile Documents/iCloud~com~seancheren~acctmind/Documents/store.json');
  });

  it('does not double the slash for a home that has one', () => {
    expect(ubiquityPath('/Users/alice/')).toBe(ubiquityPath('/Users/alice'));
  });

  it('puts the file in DOCUMENTS, which is the part iCloud Drive shows', () => {
    // `NSUbiquitousContainerIsDocumentScopePublic` publishes the Documents
    // folder and nothing else. A file one level up syncs and is invisible,
    // which is the same as not being the owner's to open.
    expect(ubiquityPath('/h')).toContain('/Documents/');
    expect(ubiquityPath('/h').endsWith(`/${STORE_FILE}`)).toBe(true);
    expect(STORE_FILE).toBe('store.json');
  });
});

/**
 * The CloudKit copy the browser reads.
 *
 * The phone writes it in Swift and the browser reads it in TypeScript; the
 * names are the only thing the two share, and nothing else would notice them
 * parting — the phone would save a record the browser never finds, and the
 * browser would say, truthfully, that there is nothing there.
 */
describe('the CloudKit copy', () => {
  const swift = readFileSync(
    new URL('../../../apps/app/modules/icloud-file/ios/ICloudFileModule.swift', import.meta.url),
    'utf8',
  );

  it('is named the same in Swift as in core', () => {
    expect(swift).toContain(`recordType: "${CK_RECORD_TYPE}"`);
    expect(swift).toContain(`recordName: "${CK_RECORD_NAME}"`);
    expect(swift).toContain(`["${CK_FIELD}"]`);
    expect(swift).toContain(`"${UBIQUITY_CONTAINER}"`);
  });

  it('is read from the environment a development-signed phone writes to', () => {
    expect(CK_ENVIRONMENT).toBe('development');
  });
});
