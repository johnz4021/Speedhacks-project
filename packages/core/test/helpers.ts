import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDomainMap } from '../src/schema';

export const mapYaml = readFileSync(new URL('../../../fixtures/scout-agent.domains.yaml', import.meta.url), 'utf8');
export const loadMap = () => parseDomainMap(mapYaml);
export const fixtureRepo = fileURLToPath(new URL('./fixture-repo', import.meta.url));
