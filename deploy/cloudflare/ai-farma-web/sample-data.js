window.FARM_DATA = {
  tenant: {id:"T-000042", name:"AXIMA", region:"EU/CZ"},
  stats:{ops:1284, ready:1261, review:18, tests:"392/392"},
  cows:[
    {name:"document.classify",state:"ACTIVE",risk:"R1",kind:"LLM",tests:"18/18"},
    {name:"invoice.extract",state:"CERTIFIED",risk:"R1",kind:"READ",tests:"24/24"},
    {name:"document.stamp",state:"ACTIVE",risk:"R2",kind:"WRITE",tests:"12/12"},
    {name:"email.send",state:"ACTIVE",risk:"R2",kind:"WRITE",tests:"9/9"},
    {name:"cz.company.verify",state:"NEW",risk:"R0",kind:"READ",tests:"—"},
    {name:"bc.vendors",state:"NEW",risk:"R1",kind:"READ",tests:"—"}
  ]
};