const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const registry=new Map();
const context=vm.createContext({HTMLElement:class {},customElements:{get:n=>registry.get(n),define:(n,c)=>registry.set(n,c)},
  window:{},navigator:{language:'en'},console,localStorage:{getItem:()=>null,setItem(){}},setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){}});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../thermostat-pro-timeline.js'),'utf8').replaceAll('import.meta.url',JSON.stringify('https://example.test/card.js')),context);
const Card=registry.get('thermostat-timeline-card');
function card(){
  const c=Object.create(Card.prototype);
  c._config={};c._schedules={};c._hasConfig=false;c._initialized=false;
  c.setConfig({entities:['climate.room']});
  c._hasConfig=true;
  return c;
}
test('repeated HA setConfig preserves settings edited in the card',()=>{
  const c=card();
  c._config.labels={'climate.room':'Living room'};
  c._config.temp_sensors={'climate.room':'sensor.temperature'};
  c._config.boiler_rooms=['climate.room'];
  c._config.boiler_enabled=true;c._config.boiler_min_temp=18;
  c.setConfig({entities:['climate.room']});
  assert.equal(c._config.labels['climate.room'],'Living room');
  assert.equal(c._config.temp_sensors['climate.room'],'sensor.temperature');
  assert.equal(c._config.boiler_enabled,true);
  assert.equal(c._config.boiler_min_temp,18);
});
test('explicit YAML settings still override saved settings including empty maps',()=>{
  const c=card();c._config.labels={'climate.room':'Living room'};
  c.setConfig({entities:['climate.room'],labels:{},boiler_enabled:false});
  assert.equal(Object.keys(c._config.labels).length,0);
  assert.equal(c._config.boiler_enabled,false);
});
test('sensor pause suppresses frontend scheduled writes and resumes when off',async()=>{
  const c=card();c._config.storage_enabled=false;c._config.auto_apply=true;
  c._config.pause_sensor_enabled=true;c._config.pause_sensor_entity='binary_sensor.summer';
  c._hass={states:{'binary_sensor.summer':{state:'on'}}};
  let writes=0;c._allTargetEntities=()=>['climate.room'];c._desiredFor=()=>20;
  c._getNowMin=()=>600;c._lastApplied={};c._applySetpointForEntity=async()=>writes++;
  await c._applyCurrentSetpoints(true);
  assert.equal(writes,0);assert.equal(c._isPaused(),true);
  c._hass.states['binary_sensor.summer'].state='off';
  assert.equal(c._isPaused(),false);
});

for (const enabled of [false,true]) {
  for (const order of ['before','after']) {
    test(`frontend turn_on enabled=${enabled}, order=${order}`,async()=>{
      const c=card(),calls=[];
      c._config.turn_on={'climate.primary':{enabled,order}};
      c._groupPrimaryOf=()=> 'climate.primary';
      c._serviceTempFromC=x=>x;
      c._hass={states:{'climate.room':{state:'off',attributes:{hvac_modes:['off','heat']}}},
        callService:async(domain,service)=>calls.push(service)};
      await c._applySetpointForEntity('climate.room',20);
      assert.deepEqual(calls,enabled?(order==='before'?['set_hvac_mode','set_temperature']:['set_temperature','set_hvac_mode']):['set_temperature']);
    });
  }
}


test('HA updates preserve block DOM unless a configured entity or display setting changes',()=>{
  const c=card(); c._initialized=true;
  c._startStoreWatchTimer=()=>{}; c._setupBoilerControl=()=>{};
  let renders=0; c._render=()=>renders++;
  const room={state:'heat',attributes:{temperature:21}};
  const hass={states:{'climate.room':room,'sensor.unrelated':{state:'1'}},locale:{language:'en'}};
  c.hass=hass;
  assert.equal(renders,1);
  for(let i=0;i<20;i++) c.hass={...hass,states:{...hass.states,'sensor.unrelated':{state:String(i)}}};
  assert.equal(renders,1);
  c.hass={...hass,states:{...hass.states,'climate.room':{...room,state:'off'}}};
  assert.equal(renders,2);
  c.hass={...c._hass,locale:{language:'de'}};
  assert.equal(renders,3);
});

test('render watch includes nested mapping entities and sensors not present on first load',()=>{
  const c=card(); c._config.merges={'climate.room':['climate.child']};
  c._config.temp_sensors={'climate.room':'sensor.missing'};
  c._config.boiler_room_settings={'climate.room':{switch:'switch.boiler'}};
  c._hass={states:{}};
  assert.equal(c._hassRenderChanged(),true);
  assert.equal(c._hassRenderChanged(),false);
  for(const id of ['climate.child','sensor.missing','switch.boiler']) {
    c._hass={states:{...c._hass.states,[id]:{state:'on'}}};
    assert.equal(c._hassRenderChanged(),true,id);
    assert.equal(c._hassRenderChanged(),false,id);
  }
  delete c._hass.states['sensor.missing'];
  assert.equal(c._hassRenderChanged(),true);
  c._config.labels={'climate.room':'New label'};
  assert.equal(c._hassRenderChanged(),true);
});

test('editing defers relevant HA refresh without forgetting the pending change',()=>{
  const c=card(); c._initialized=true;
  c._startStoreWatchTimer=()=>{}; c._setupBoilerControl=()=>{};
  let renders=0; c._render=()=>renders++;
  c.hass={states:{'climate.room':{state:'heat'}}};
  c._editing=true;
  c.hass={states:{'climate.room':{state:'off'}}};
  assert.equal(renders,1);
  c._editing=false;
  c.hass=c._hass;
  assert.equal(renders,2);
});

test('shared storage card initialization does not send climate temperature commands',async()=>{
  const c=card(); c._config.storage_enabled=true;
  const calls=[];
  c._init=()=>{}; c._loadStore=async()=>{}; c._ensureSchedules=()=>{};
  c._hydrateUiNamesFromBackend=async()=>{}; c._hydrateInstanceCfgFromLocal=()=>{};
  c._restoreSyncDue=()=>{}; c._render=()=>{}; c._scheduleNextApply=()=>{};
  c._debouncedSaveStore=()=>{}; c._startStoreWatchTimer=()=>{}; c._setupBoilerControl=()=>{};
  c.hass={states:{'climate.room':{state:'heat',attributes:{temperature:22.5}}},
    callService:async(...args)=>calls.push(args)};
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.filter(args=>args[0]==='climate').length,0);
});

test('explicit Heat/Off periods preserve legacy targets and respect half-open boundaries',()=>{
  const c=card();
  c._schedules['climate.room']={defaultTemp:17,blocks:[
    {id:'legacy',startMin:60,endMin:120,temp:21},
    {id:'off',startMin:120,endMin:180,hvacMode:'off'},
    {id:'heat',startMin:180,endMin:240,temp:20,hvacMode:'heat'},
  ]};
  assert.equal(c._desiredTempFor('climate.room',90),21);
  assert.equal(JSON.stringify(c._desiredActionFor('climate.room',90)),JSON.stringify({hvacMode:null,temperature:21}));
  assert.equal(JSON.stringify(c._desiredActionFor('climate.room',120)),JSON.stringify({hvacMode:'off',temperature:null}));
  assert.equal(JSON.stringify(c._desiredActionFor('climate.room',180)),JSON.stringify({hvacMode:'heat',temperature:20}));
  c._schedules['climate.room'].defaultMode='off';
  assert.equal(JSON.stringify(c._desiredActionFor('climate.room',240)),JSON.stringify({hvacMode:'off',temperature:null}));
});

test('block editor opens with the stored mode and Off labels contain no temperature',()=>{
  const c=card();
  c._schedules['climate.room']={defaultTemp:17,blocks:[{id:'off',startMin:60,endMin:120,temp:21}]};
  c._editing={entity:'climate.room',blockId:'off',weeklyDay:'sat'};
  c._weeklyDraft={days:{sat:[{id:'off',startMin:60,endMin:120,hvacMode:'off'}]}};
  c.shadowRoot={querySelector:()=>null};
  let mode,opened=0;
  c._setEditorMode=value=>mode=value;
  c._openBlockOverlay({classList:{add:()=>opened++}});
  assert.equal(mode,'off');
  assert.equal(opened,1);
  assert.equal(c._blockLabel({hvacMode:'off'}),'Off');
});

test('weekday editor saves the selected Off mode without changing its time interval',async()=>{
  const c=card();
  c._schedules['climate.room']={defaultTemp:17,blocks:[]};
  c._editing={entity:'climate.room',blockId:'block',weeklyDay:'sat'};
  c._weeklyDraft={days:{sat:[{id:'block',startMin:540,endMin:1080,temp:21}]}};
  const inputs={'.ed-mode':{dataset:{mode:'off'}},'.ed-temp':{value:'21'},'.ed-from':{value:'09:00'},'.ed-to':{value:'18:00'}};
  c.shadowRoot={querySelector:selector=>inputs[selector]||null};
  c._closeEditor=()=>{};c._renderWeeklyModal=()=>{};c._desiredNowSnapshot=()=>({});
  await c._saveEditor();
  const block=c._weeklyDraft.days.sat[0];
  assert.equal(block.hvacMode,'off');
  assert.equal(block.startMin,540);
  assert.equal(block.endMin,1080);
});

test('explicit Off sends no setpoint; explicit Heat sets target before enabling',async()=>{
  const c=card(),calls=[];
  c._hass={states:{'climate.room':{state:'heat',attributes:{hvac_modes:['off','heat']}}},
    callService:async(domain,service,data)=>calls.push({service,data})};
  assert.equal(await c._applySetpointForEntity('climate.room',0,'off'),true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{service:'set_hvac_mode',data:{entity_id:'climate.room',hvac_mode:'off'}}]);
  calls.length=0;c._hass.states['climate.room'].state='off';
  assert.equal(await c._applySetpointForEntity('climate.room',21,'heat'),true);
  assert.deepEqual(calls.map(call=>call.service),['set_temperature','set_hvac_mode']);
  assert.equal(calls[0].data.temperature,21);
  c._config.apply_enabled={'climate.room':false};calls.length=0;
  await c._applySetpointForEntity('climate.room',0,'off');
  assert.equal(calls.length,0);
});

test('weekday midnight splits retain Off and legacy editing clears the mode',async()=>{
  for (const mode of ['off','']) {
    const c=card();
    c._schedules['climate.room']={defaultTemp:17,blocks:[]};
    c._editing={entity:'climate.room',blockId:'block',weeklyDay:'sat'};
    c._weeklyDraft={days:{sat:[{id:'block',startMin:540,endMin:1080,temp:21,hvacMode:'heat'}]}};
    const inputs={'.ed-mode':{dataset:{mode}},'.ed-temp':{value:'21'},'.ed-from':{value:'23:00'},'.ed-to':{value:'02:00'}};
    c.shadowRoot={querySelector:selector=>inputs[selector]||null};
    c._closeEditor=()=>{};c._renderWeeklyModal=()=>{};c._desiredNowSnapshot=()=>({});
    await c._saveEditor();
    const blocks=c._weeklyDraft.days.sat;
    assert.equal(blocks.length,2);
    assert.deepEqual(Array.from(blocks,block=>[block.startMin,block.endMin,block.hvacMode]),[[0,120,mode||null],[1380,1440,mode||null]]);
  }
});

test('mode-only boundaries apply and failed commands are retried without cached success',async()=>{
  const c=card();let minute=60;
  c._config.auto_apply=true;c._config.storage_enabled=false;c._lastApplied={};
  c._getNowMin=()=>minute;c._isPaused=()=>false;c._allTargetEntities=()=>['climate.room'];
  c._hass={states:{'climate.room':{state:'off',attributes:{temperature:21,hvac_modes:['heat','off']}}},callService:async()=>{}};
  c._schedules['climate.room']={defaultTemp:17,blocks:[{startMin:60,endMin:120,temp:21,hvacMode:'heat'},{startMin:120,endMin:180,temp:21,hvacMode:'off'}]};
  const calls=[];c._applySetpointForEntity=async(eid,temp,mode)=>{calls.push(mode);return true;};
  await c._applyCurrentSetpoints();minute=120;await c._applyCurrentSetpoints();
  assert.deepEqual(calls,['heat','off']);
  c._lastApplied={};c._applySetpointForEntity=async()=>false;
  await c._applyCurrentSetpoints();assert.equal(c._lastApplied['climate.room'],undefined);
  let retry=0;c._applySetpointForEntity=async()=>{retry++;return true;};
  await c._applyCurrentSetpoints();assert.equal(retry,1);
});

test('failed Heat target never enables heat and input_number modes stay numeric',async()=>{
  const c=card(),calls=[];
  c._hass={states:{'climate.room':{state:'off',attributes:{hvac_modes:['off','heat']}}},callService:async(domain,service)=>{calls.push(service);throw Error('failed');}};
  assert.equal(await c._applySetpointForEntity('climate.room',21,'heat'),false);
  assert.deepEqual(calls,['set_temperature']);
  c._schedules['input_number.room']={defaultTemp:17,defaultMode:'off',blocks:[{startMin:60,endMin:120,temp:21,hvacMode:'off'}]};
  assert.equal(JSON.stringify(c._desiredActionFor('input_number.room',60)),JSON.stringify({hvacMode:null,temperature:21}));
});

test('effective weekday actions prefer copied mode data and retain legacy fallback',()=>{
  const c=card();c._config.weekdays_enabled=true;c._todayKey=()=>'sun';
  const row={defaultTemp:18.5,defaultMode:'heat',blocks:[],weekly:{mode:'all_7',days:{sun:[{startMin:60,endMin:120,temp:21}]}},weekly_modes:{all_7:{days:{sun:[{startMin:60,endMin:120,hvacMode:'off'}]}}}};
  c._schedules['climate.room']=row;
  assert.equal(JSON.stringify(c._desiredActionFor('climate.room',90)),JSON.stringify({hvacMode:'off',temperature:null}));
  row.weekly_modes.all_7.days.sun=[];
  assert.equal(JSON.stringify(c._desiredActionFor('climate.room',90)),JSON.stringify({hvacMode:'heat',temperature:18.5}));
  delete row.weekly_modes.all_7.days.sun;
  assert.equal(JSON.stringify(c._desiredActionFor('climate.room',90)),JSON.stringify({hvacMode:null,temperature:21}));
});
