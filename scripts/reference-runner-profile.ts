import { readFile } from 'node:fs/promises';
import { codeRuleValidationProfileSchema, sha256Schema, standardBuildProfileSchema, standardVerificationProfileSchema } from '@itervane/contracts';
import { scannerProfiles, sha256 } from '@itervane/runner';

async function prepareProfiles(args: string[]) {
  const [image, inspection, build, oci, semgrep] = args;
  if (args.length !== 5 || !image || !inspection || !build || !oci || !semgrep) throw new Error('profile_arguments_invalid');
  const [imageRecord, scanInputs, buildInputs, imageInputs, rules] = await Promise.all([
    readFile(image), readFile(inspection), readFile(build), readFile(oci), readFile(semgrep),
  ]);
  const runnerImageSha256 = sha256Schema.parse(JSON.parse(imageRecord.toString('utf8')).rawSha256);
  const buildProfile = standardBuildProfileSchema.parse(JSON.parse(buildInputs.toString('utf8')));
  const ociInputsSha256 = sha256(imageInputs);
  if (buildProfile.ociInputsSha256 !== ociInputsSha256) throw new Error('profile_oci_binding_invalid');
  const verification = standardVerificationProfileSchema.parse({
    id: 'reference-standard-web', runnerImageSha256, baselineSha256: buildProfile.baselineSha256,
    policySha256: sha256(JSON.stringify(scannerProfiles)), scannerInputsSha256: sha256(scanInputs),
    buildProfileSha256: sha256(buildInputs), runStandardBaseline: true, ociInputsSha256, retainStandardImage: true,
  });
  const { version, engine, engineVersion } = JSON.parse(rules.toString('utf8'));
  const rulesProfile = codeRuleValidationProfileSchema.parse({ version, engine, engineVersion,
    engineInputsSha256: sha256(rules), runnerImageSha256 });
  return [
    'ITERVANE_FORMAL_REPAIR=1',
    `ITERVANE_VERIFICATION_PROFILE=${JSON.stringify(verification)}`,
    'ITERVANE_CANDIDATE_VALIDATION_ENABLED=1',
    `ITERVANE_CODE_RULE_VALIDATION_PROFILE=${JSON.stringify(rulesProfile)}`,
  ];
}

try {
  const settings = await prepareProfiles(process.argv.slice(2));
  process.stdout.write(settings.join('\n') + '\n');
} catch (error) {
  const reason = error instanceof Error && /^profile_[a-z_]+$/.test(error.message) ? error.message : 'profile_preparation_failed';
  console.error(reason);
  process.exitCode = 1;
}
