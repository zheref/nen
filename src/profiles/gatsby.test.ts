import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect } from "../shu/detect.js";
import { loadProfilesPack, profileById } from "./pack.js";
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture():string {const root=mkdtempSync(join(tmpdir(),"nen-gatsby-adoption-"));roots.push(root);cpSync(join(process.cwd(),"fixtures/gatsby-jest"),root,{recursive:true});return root;}
describe("Gatsby recommended Jest adoption (#530)",()=>{
  it("recommends the fixture-proven local runner, test report and LCOV artifact after explicit configuration adoption",()=>{const root=fixture();const lane=detect(root,"linux").lanes.find(entry=>entry.stack==="gatsby");expect(lane?.verbs.test).toMatchObject({exe:"node",argv:["node_modules/jest/bin/jest.js","--config","jest.config.cjs","--runInBand","--json","--outputFile=jest-results.json"],artifacts:["jest-results.json"]});expect(lane?.verbs.coverage).toMatchObject({exe:"node",artifacts:["coverage/lcov.info"]});});
  for(const file of ["jest.config.cjs","jest-preprocess.cjs","setup-test-env.cjs"]){it(`withholds test/coverage when ${file} has not been adopted`,()=>{const root=fixture();unlinkSync(join(root,file));const lane=detect(root,"linux").lanes.find(entry=>entry.stack==="gatsby");expect(lane?.verbs.test).toMatchObject({unsupported:expect.stringContaining(file)});expect(lane?.verbs.coverage).toMatchObject({unsupported:expect.stringContaining(file)});});}
  it("roots report artifacts at the nested lane without changing the runner cwd",()=>{const root=mkdtempSync(join(tmpdir(),"nen-gatsby-nested-"));roots.push(root);mkdirSync(join(root,"apps"));cpSync(join(process.cwd(),"fixtures/gatsby-jest"),join(root,"apps/site"),{recursive:true});const lane=detect(root,"linux").lanes.find(entry=>entry.stack==="gatsby");expect(lane?.verbs.test).toMatchObject({artifacts:["apps/site/jest-results.json"]});expect(lane?.verbs.coverage).toMatchObject({artifacts:["apps/site/coverage/lcov.info"]});});
  it("leaves the consumer's required tests, coverage ladder and contract untouched",()=>{const root=fixture();const workflow=readFileSync(join(root,"nen/workflow.json"),"utf8");const contract=readFileSync(join(root,"nen/contract.json"),"utf8");detect(root,"linux");expect(readFileSync(join(root,"nen/workflow.json"),"utf8")).toBe(workflow);expect(readFileSync(join(root,"nen/contract.json"),"utf8")).toBe(contract);const profile=profileById(loadProfilesPack(),"gatsby");expect(profile.verbs["ui-test"]?.kind).toBe("unsupported");expect(profile.reportDefault.path).toBe("coverage/lcov.info");});
});
