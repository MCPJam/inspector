const fs=require('fs');
const base=process.env.MCPJAM_API_URL;const headers={Authorization:`Bearer ${process.env.MCPJAM_API_KEY}`,'Content-Type':'application/json'};
async function api(path,body){const r=await fetch(`${base}/projects/project_fixture/${path}`,{headers,method:body?'POST':'GET',body:body?JSON.stringify(body):undefined});return r.json()}
(async()=>{
const s=JSON.parse(fs.readFileSync('minimal-suite.json'));s.tests[0].steps.push({id:'assert_called',kind:'assert',assertion:{type:'toolCalledAtLeastOnce',toolName:'add'}},{id:'assert_no_errors',kind:'assert',assertion:{type:'noToolErrors'}});
fs.writeFileSync('simple-suite.json',JSON.stringify(s,null,2));
const created=await api('eval-suites',s);fs.writeFileSync('reports/simple-suite-created.json',JSON.stringify(created,null,2));console.log(created);
const run=await api('eval-runs',{suiteId:created.suiteId});fs.writeFileSync('reports/simple-launch.json',JSON.stringify(run,null,2));console.log(run);
for(const [label,id] of [['first','run_fixture_1'],...(run.runId?[['simple',run.runId]]:[])]){
for(const [suffix,name] of [['','status'],['/iterations','iterations'],['/decision-summary','decision']]){const data=await api(`eval-runs/${id}${suffix}`);fs.writeFileSync(`reports/${label}-${name}.json`,JSON.stringify(data,null,2));console.log(label,name,JSON.stringify(data));}
}
})().catch(e=>{console.error(e);process.exitCode=1});
