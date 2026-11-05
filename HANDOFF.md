# TermBeacon 浠诲姟浜ゆ帴鏂囨。

鏇存柊鏃堕棿锛?026-11-05锛圓sia/Shanghai锛? 
椤圭洰鐩綍锛歚D:\\01-cmcc\\codes-win\\75_TermBeacon`  
褰撳墠闃舵锛歁VP 宸插畬鎴愬熀纭€閾捐矾锛岃繘鍏ョ湡瀹?CLI 鍐掔儫銆佺ǔ瀹氭€у拰鐘舵€佹娴嬪寮洪樁娈点€?
## 1. 椤圭洰鐩爣

TermBeacon 鏄竴涓?Windows 缁堢绠＄悊宸ュ叿锛岀敤涓€涓獥鍙ｈ仛鍚堝涓湰鍦扮粓绔拰 CLI Agent銆傚乏渚ф樉绀虹粓绔?宸ヤ綔鍖哄垪琛ㄥ拰鐘舵€佺伅锛屽彸渚ф樉绀哄綋鍓?xterm.js 缁堢銆侫gent 瀹屾垚浠诲姟鍚庯紝鐘舵€佺伅鍙樹负楂樹寒锛涚敤鎴峰垏鎹㈡煡鐪嬫椂锛岀姸鎬佺珛鍗宠浆涓衡€滃氨缁€濄€?
鐩爣 CLI锛歚opencode`銆丆odex CLI銆丆laude Code锛屼互鍙婃櫘閫?Shell 鐨?`generic` 妯″紡銆?
## 2. 褰撳墠瀹屾垚鎯呭喌

### 宸ョ▼鍩虹

- Electron + React + TypeScript + Vite 宸ョ▼宸插缓绔嬨€?- xterm.js 鍜?FitAddon 宸叉帴鍏ャ€?- node-pty + Windows ConPTY 宸叉帴鍏ャ€?- Electron `utilityProcess` 宸茬嫭绔嬭繍琛?`pty-host.cjs`銆?- `MessageChannelMain` / `MessagePort` 宸茬敤浜?PTY 楂橀鏁版嵁闈€?- 鐢熶骇鏋勫缓鑴氭湰浼氬鍒?CJS runtime 鏂囦欢鍒?`dist/main`銆?
### 缁堢鍔熻兘

- 鏀寔澶氫釜缁堢瀹炰緥銆?- 宸︿晶鍒楄〃鏀寔鍒涘缓鍜屽垏鎹€?- 鍒囨崲鏃堕殣钘忕粓绔?DOM锛孭TY 鍜?xterm 瀹炰緥缁х画瀛樻椿銆?- 鍚庡彴缁堢缁х画鎺ユ敹杈撳嚭銆?- 鏀寔杈撳叆銆佽緭鍑恒€丄NSI 棰滆壊銆佹粴鍔ㄥ拰 resize銆?- 鏀寔鍋滄缁堢銆?- 淇濆瓨缁堢鏍囬銆丆WD銆丄gent 绫诲瀷銆佺姸鎬佸拰鏈€杩戞椿鍔ㄤ俊鎭€?
### Agent 鍜岀姸鎬佹娴?
- Agent Registry 宸插寘鍚細`generic`銆乣opencode`銆乣codex`銆乣claude`銆?- 鐘舵€佹満鍖呭惈锛歚working`銆乣completed-unseen`銆乣ready`銆乣awaiting-input`銆乣error`銆乣stopped`銆?- 妫€娴嬪櫒鏀寔鐢ㄦ埛杈撳叆銆丳TY 杈撳嚭銆侀潤榛樼‘璁ょ獥鍙ｃ€佹彁绀虹/瀹屾垚妯″紡銆佸伐鍏锋墽琛屼繚鎶ゃ€佹煡鐪嬪浣嶃€丠ook 浜嬩欢鍜岃繘绋嬮€€鍑恒€?- OSC 9;4 瑙ｆ瀽鍑芥暟宸插瓨鍦ㄥ苟鏈夋祴璇曘€?- Hook 缂哄け鏃朵粛浼氳蛋杈撳嚭瑙傚療璺緞銆?- 宸︿晶鐘舵€佺伅宸茬粡鎸夌姸鎬佹樉绀洪鑹插拰鍔ㄦ晥銆?
### CLI 鎺㈡祴

`src/main/cli-discovery.cjs` 浣跨敤 `where.exe` 鏌ユ壘 CLI 骞惰繍琛?`--version`銆備笂娆￠獙璇佹湰鏈哄彂鐜帮細

- opencode锛歚v2.2.1`
- Codex CLI锛歚0.166.0`
- Claude Code锛歚2.1.316`

鐗堟湰浼氶殢鏈満鐜鍙樺寲锛屾柊鐨勪細璇濆簲閲嶆柊杩愯 CLI 鎺㈡祴锛屼笉瑕佹妸杩欎簺鐗堟湰褰撲綔姘镐箙鍥哄畾鍊笺€?
### 娴嬭瘯鍜屾瀯寤?
涓婃鍩虹嚎楠岃瘉缁撴灉锛?
```text
npm test
12 tests passed, 0 failed

npm run build
TypeScript銆乂ite 鍜?runtime copy 鍧囬€氳繃
```

鐢熶骇鍚姩鏇惧彂鐜板苟宸蹭慨澶嶄袱涓棶棰橈細

1. `cli-discovery.cjs` 鏈鍒跺埌 `dist/main`锛屽凡鍔犲叆 `scripts/copy-runtime.mjs`銆?2. utility process 涓敊璇娇鐢?`require("electron").parentPort`锛屽凡鏀逛负浼樺厛浣跨敤 `process.parentPort` 骞朵繚鐣欏吋瀹瑰洖閫€銆?
鐢熶骇鍚姩涔嬪悗鍙嚭鐜拌繃 Electron 鏈湴纾佺洏缂撳瓨鏉冮檺鎻愮ず锛屾病鏈夐樆姝㈢獥鍙ｅ拰 PTY host 鍚姩銆備笅涓€娆″紑鍙戜粛闇€閲嶆柊杩愯 `npm start` 楠岃瘉褰撳墠浠ｇ爜銆?
## 3. 鍏抽敭鏂囦欢

```text
README.md
HANDOFF.md
docs/development-handbook.md
docs/continuation-prompt.md
docs/termbeacon-engineering-spec.md

src/main/main.ts
src/main/preload.cjs
src/main/pty-host.cjs
src/main/detection-engine.cjs
src/main/agent-registry.cjs
src/main/cli-discovery.cjs
src/renderer/App.tsx
src/renderer/styles.css
src/shared/types.ts
scripts/copy-runtime.mjs

tests/detection-engine.test.cjs
tests/fixtures.test.cjs
tests/osc-progress.test.cjs
tests/fixtures/agents/*.jsonl
```

## 4. 褰撳墠宸茬煡闂鍜岄檺鍒?
### 楂樹紭鍏堢骇

- 鐪熷疄 CLI 绔埌绔涓鸿繕娌℃湁褰㈡垚绋冲畾鐨勮嚜鍔ㄥ寲 smoke 娴嬭瘯銆?- PTY 鍒涘缓鍜岄€€鍑哄凡澧炲姞缁撴瀯鍖栭敊璇洖浼犮€侀噸澶嶅垱寤轰繚鎶ゃ€佸弬鏁版牎楠屻€佺敤鎴峰仠姝㈠師鍥犲拰 utility host 鑷姩閲嶈繛锛涗粛缂哄皯鐪熷疄 CLI/ConPTY 鑷姩鍖?smoke 娴嬭瘯銆?- `main.ts` 鐨勭粓绔櫥璁板拰鏁版嵁闈㈡秷鎭牎楠岃繕姣旇緝钖勫急锛岄渶瑕佽ˉ鍏呯粓绔?ID銆佸昂瀵搞€丆WD 鍜屾秷鎭粨鏋勬牎楠屻€?- 褰撳墠杈撳嚭涓昏鐩存帴鍐欏叆姣忎釜 xterm 瀹炰緥锛屽皻鏈疄鐜扮嫭绔嬬殑鏈夐檺鍐呭瓨杈撳嚭缂撳啿鍜屾柇绾?閲嶈繛 replay銆?- Agent 鐘舵€佹娴嬩粛鏄涓€鐗堟ā寮忓尮閰嶏紝鐪熷疄 CLI 鐗堟湰鍙樺寲鍙兘瀵艰嚧璇姤鎴栨紡鎶ャ€?
### 涓紭鍏堢骇

- Claude Stop/TaskCompleted Hook 鍙湁缁熶竴鍏ュ彛鍜?Registry 澹版槑锛屽皻鏈畬鎴愮湡瀹?Hook 閰嶇疆銆佹帴鏀跺拰澶辨晥鍥為€€娴佺▼銆?- Codex 鍘熺敓鐘舵€佷簨浠跺皻鏈帴鍏ョ湡瀹?CLI 閫氶亾銆?- OSC 9;4 鐩墠宸茶В鏋愬拰娴嬭瘯锛屼絾杩樻病鏈変綔涓哄€欓€夎瘎鍒嗕俊鍙峰畬鏁存帴鍏ョ姸鎬佸喅绛栥€?- 鐢ㄦ埛淇敼 Agent 绫诲瀷鍚庯紝宸叉湁 PTY 鐨?detector 閰嶇疆涓嶄細鑷姩閲嶅缓锛岄渶瑕佹槑纭鐢ㄣ€侀噸鍚?detector 鎴栭噸寤虹粓绔殑绛栫暐銆?- CWD 褰撳墠榛樿鍊煎啓姝讳负 `C:\\`锛屾病鏈夌洰褰曢€夋嫨鍜屾湁鏁堟€ф鏌ャ€?- 缁堢鏍囬銆佸伐浣滃尯绠＄悊銆佸叧闂‘璁ゃ€佺獥鍙ｅ昂瀵稿拰渚ф爮瀹藉害灏氭湭瀹屾暣鎸佷箙鍖栥€?- PTY 涓嶈法搴旂敤閲嶅惎瀛樻椿锛岃繖鏄?v1 璁捐杈圭晫锛屼笉瑕佽璁や负鏄?bug銆?
### 鍙戝竷绾?
- 灏氭湭閰嶇疆 electron-builder/Forge 瀹夎鍖呫€?- 灏氭湭瀹屾垚 node-pty 鍘熺敓妯″潡鍦ㄥ共鍑€ Windows 鐜鐨勬墦鍖呴獙璇併€?- 灏氭湭鍔犲叆绛惧悕銆佽嚜鍔ㄦ洿鏂般€佸穿婧冩姤鍛婂拰鍗囩骇鍥炴粴绛栫暐銆?
## 5. 涓嬩竴姝ュ缓璁?
鎸変笅闈㈤『搴忔帹杩涳紝浼樺厛淇濊瘉鍙獙璇佺殑鐢ㄦ埛浠峰€笺€?
### 绗竴姝ワ細绋冲畾 PTY 閾捐矾

1. 缁?`pty-host.cjs` 澧炲姞 `pty:create` 澶辫触娑堟伅鍜屽紓甯告崟鑾枫€?2. 闃叉鍚屼竴涓?`terminalId` 閲嶅鍒涘缓瀵艰嚧鏃?session 娉勬紡銆?3. 鍖哄垎鐢ㄦ埛鍋滄銆佽嚜鐒堕€€鍑恒€侀潪闆堕€€鍑哄拰 host 宕╂簝銆?4. 澶勭悊鏃犳晥 CWD銆丼hell 鍚姩澶辫触銆乺esize 闈炴硶灏哄銆?5. 缁?preload 鍜?host 澧炲姞绔彛鏂紑/閲嶈繛淇濇姢銆?6. 娣诲姞鍙噸澶嶇殑 PTY smoke 娴嬭瘯鎴栨墜宸ラ獙鏀惰褰曘€?
楠屾敹锛氳嚦灏戝垱寤?5 涓粓绔紝杞祦杈撳叆鍛戒护骞跺垏鎹紱鍚庡彴缁堢涓嶄涪杈撳嚭锛涘仠姝竴涓粓绔笉褰卞搷鍏朵粬缁堢銆?
### 绗簩姝ワ細鐪熷疄 CLI 鍐掔儫

1. 鍦ㄦ湰鏈烘帰娴?opencode銆丆odex CLI銆丆laude Code銆?2. 涓烘瘡涓?CLI 閫夋嫨涓€涓渶灏忓彲閫€鍑烘垨鏈€灏忕瓑寰呰緭鍏ョ殑鍛戒护銆?3. 璁板綍瀹為檯杈撳嚭涓殑鎻愮ず绗︺€佸伐鍏锋墽琛屻€佹潈闄愯闂拰瀹屾垚鏂囨湰銆?4. 鎶婅劚鏁忚緭鍑哄仛鎴?JSONL fixture銆?5. 鏍规嵁 fixture 璋冩暣 Registry锛岃€屼笉鏄洿鎺ョ粰妫€娴嬪櫒鍔?CLI 鐗瑰垽銆?
楠屾敹锛氫笁涓?CLI 閮借兘浠?TermBeacon 鍚姩锛涘伐浣滀腑銆佺瓑寰呰緭鍏ャ€佸畬鎴愩€佸紓甯稿拰閫€鍑虹姸鎬佸彲瑙ｉ噴锛汬ook 涓嶅彲鐢ㄦ椂浠嶈兘鍥為€€鍒拌緭鍑烘娴嬨€?
### 绗笁姝ワ細鐘舵€佹娴嬪寮?
1. 寮曞叆鏄庣‘鐨?`DetectionSignal` 绫诲瀷鎴栫瓑浠峰唴閮ㄧ粨鏋勩€?2. 鍒嗗紑璁板綍 prompt銆乧ompletion銆亀aiting-input銆乼ool-start銆乼ool-end銆乭ook銆丱SC 鍜?silence 淇″彿銆?3. 涓烘瘡涓?Agent 澧炲姞鐗堟湰鍖栨ā寮忛厤缃拰娴嬭瘯鍏ュ彛銆?4. 灏?OSC 9;4 浣滀负杈呭姪淇″彿鍙備笌璇勫垎锛屼笉鐩存帴瑕嗙洊鐘舵€併€?5. 涓?Hook 澧炲姞瓒呮椂銆佸け鏁堝拰鍥為€€鏈哄埗銆?6. 澧炲姞鈥滀负浠€涔堢偣浜€濈殑璋冭瘯鏃ュ織鎴栧紑鍙戞ā寮忛潰鏉裤€?
楠屾敹锛氱函闈欓粯涓嶅畬鎴愶紱宸ュ叿杩愯鏈熼棿涓嶅畬鎴愶紱绛夊緟宸ュ叿杩斿洖涓嶈璇垽涓哄畬鎴愶紱鐢ㄦ埛鐐瑰嚮鍚庨珮浜珛鍗虫秷澶便€?
### 绗洓姝ワ細缂撳啿鍜屾寔涔呭寲

1. 涓烘瘡涓粓绔鍔?2-4 MB 鏈変笂闄愮殑鍐呭瓨杈撳嚭缂撳啿銆?2. 璁捐杈撳嚭搴忓彿鍜?replay 娑堟伅锛屽垏鎹?閲嶈繛鏃惰ˉ鍙戞湭娑堣垂杈撳嚭銆?3. 淇濈暀 xterm scrollback 20,000 琛屼綔涓烘覆鏌撳眰涓婇檺銆?4. 鍙€夊疄鐜扮鐩樺揩鐓э紝浣嗗繀椤婚檺鍒跺閲忓苟閬垮厤棰戠箒鍐欑洏銆?5. 瀹屽杽宸ヤ綔鍖恒€佹爣棰樸€丆WD銆丄gent 绫诲瀷鍜屼笂娆℃縺娲荤粓绔仮澶嶃€?
### 绗簲姝ワ細鍙戝竷宸ョ▼鍖?
1. 閫夋嫨 electron-builder 鎴?Forge銆?2. 閰嶇疆 node-pty 鍘熺敓妯″潡鍜?ConPTY 鎵撳寘銆?3. 鍦ㄦ病鏈?Node.js 鐨勫共鍑€ Windows 鐜瀹夎杩愯銆?4. 鍐嶈€冭檻绛惧悕銆佽嚜鍔ㄦ洿鏂般€佸穿婧冩姤鍛婂拰鐗堟湰杩佺Щ銆?
## 6. 寮€鍙戠害鏉?
- 寮€濮嬫敼鍔ㄥ墠鍏堣 `docs/development-handbook.md` 鍜?`docs/termbeacon-engineering-spec.md`銆?- 鍏堝啓 fixture/娴嬭瘯锛屽啀淇敼妫€娴嬭鍒欍€?- 涓嶈鎶?Node API銆佸瓙杩涚▼鍚姩鎴栨枃浠剁郴缁熸搷浣滄斁杩?React 缁勪欢銆?- 涓嶈璁╅珮棰?PTY 杈撳嚭閲嶆柊缁忚繃涓昏繘绋嬮€愬潡杞彂銆?- 涓嶈渚濊禆鍗曚竴 Hook銆佸崟涓€鍥哄畾鏂囨湰鎴栫函闈欓粯鍒ゆ柇瀹屾垚銆?- 涓嶈鐢ㄧ牬鍧忔€?Git 鍛戒护瑕嗙洊鍏朵粬 Agent 鐨勫伐浣溿€?- 鏂板 CJS 鏂囦欢鍚庡繀椤绘洿鏂?`scripts/copy-runtime.mjs`銆?- 淇敼瀹屾垚鍚庤嚦灏戣繍琛?`npm test` 鍜?`npm run build`銆?- 鐪熷疄 Electron 鐩稿叧鏀瑰姩瑕佽繍琛?`npm start` 骞舵鏌ョ獥鍙ｅ拰 PTY host銆?- 瀹屾垚涓€涓壒娆″悗鏇存柊鏈枃浠讹紝璁板綍瀹屾垚椤广€侀獙璇佺粨鏋滃拰鏂伴棶棰樸€?
## 6.1 鏈壒娆¤褰曪紙2026-11-05锛?
- 鏂板 `src/main/pty-validation.cjs`锛岀粺涓€鏍￠獙缁堢 ID銆佺粷瀵?CWD銆乻hell 鍙傛暟銆佺幆澧冨彉閲忋€丄gent 绫诲瀷鍜屽昂瀵歌寖鍥达紱宸插姞鍏?runtime copy銆?- `pty-host.cjs` 鐜板湪鎷掔粷閲嶅鍒涘缓锛屽鐞嗘棤鏁?CWD銆侀潪娉曡緭鍏?resize/kill 璇锋眰鍜?shell spawn 寮傚父锛屽苟鍙戦€?`pty:create-result` / `pty:error` / 甯﹀師鍥犵殑 `pty:exit`銆?- `preload.cjs` 涓哄垱寤鸿姹傜淮鎶?`requestId`銆佽秴鏃跺拰澶辫触 Promise锛涚洃鍚暟鎹鍙ｉ敊璇笌 host 閫€鍑恒€?- `main.ts` 鐩戝惉 utility process 閫€鍑猴紝鍚?renderer 鍙戦€?host 閫€鍑轰簨浠跺苟鑷姩閲嶅缓 host 涓?MessagePort銆?- `App.tsx` 灞曠ず鍒涘缓澶辫触銆乭ost 鏂紑鍜岀敤鎴峰仠姝㈢粨鏋滐紝閬垮厤澶辫触璇锋眰闈欓粯鍗″湪鈥滃氨缁€濄€?- 楠岃瘉锛歚npm test` 17 椤归€氳繃锛沗npm run build` 閫氳繃锛沗npm start` 鍚姩鍐掔儫鏃犲紓甯歌緭鍑哄悗鎵嬪姩缁撴潫銆?
## 7. 鏂颁細璇濆惎鍔ㄥ懡浠?
```powershell
cd D:\\01-cmcc\\codes-win\\75_TermBeacon
npm install
npm test
npm run build
npm start
```

鏂颁細璇濆彲浠ョ洿鎺ヤ娇鐢?[docs/continuation-prompt.md](docs/continuation-prompt.md) 涓殑鎻愮ず璇嶏紝鐒跺悗琛ュ厖鏈鍏蜂綋浠诲姟鍜岄獙鏀舵爣鍑嗐€?
## 8. 褰撳墠浜ゆ帴缁撹

MVP 鐨勬牳蹇冩灦鏋勫拰妫€娴嬪熀纭€宸茬粡钀藉湴锛岄」鐩彲浠ョ户缁紑鍙戙€備笅涓€浣?Agent 涓嶉渶瑕侀噸鏂版惌寤哄伐绋嬶紝搴斾粠 PTY 绋冲畾鎬с€佺湡瀹?CLI 鍐掔儫鍜屾娴嬩俊鍙疯瘖鏂紑濮嬨€傚畬鎴愪换浣曚竴涓壒娆″悗锛屽簲鎶婃柊鐨勪簨瀹炪€佹祴璇曠粨鏋滃拰鍓╀綑闄愬埗鍥炲啓鍒版湰鏂囦欢銆?
## 6.2 Detection hardening batch (2026-11-05)

- Extended `src/main/detection-engine.cjs` with a bounded rolling signal tail so completion and prompt markers split across PTY chunks can still be recognized.
- Completion candidates are retained while a tool is marked in flight, but completion is blocked until the configured `maxToolGraceMs` quiet window (8 seconds) has elapsed. This prevents a missing tool-end marker from permanently wedging the detector while preserving the short-term working state.
- OSC 9;4 progress is recorded as auxiliary evidence. Progress 100 by itself does not complete a task; it can only annotate a candidate that also has prompt/completion evidence.
- Added regression coverage for split completion markers, missing tool-end markers, and OSC-only progress.

Validation:

- `npm test`: 21 passed, 0 failed.
- `npm run build`: passed; runtime files copied to `dist/main`.
- `npm start`: Electron launched successfully and was manually stopped after smoke verification.
- Local CLI discovery: opencode v2.2.1, codex-cli 0.166.0, Claude Code 2.1.316.

Next recommended batch: run a real CLI/ConPTY smoke matrix for one short command or prompt per installed CLI, capture sanitized output fixtures, and then adjust only Registry patterns where the recorded output demonstrates a mismatch. Known limitation remains that changing an existing terminal's Agent type does not rebuild its detector; restart or recreate that terminal before changing detector configuration.


## 6.3 Real CLI/ConPTY smoke batch (2026-11-05)

- Added `scripts/cli-smoke.cjs` and the `npm run smoke:cli` command. It launches each installed registered CLI through `cmd.exe` and node-pty/ConPTY, captures a bounded ANSI-stripped version line, verifies natural exit, and exits cleanly after all PTY handles are released.
- Verified the current machine's installed CLIs:
  - `opencode v2.2.1` (exit code 0)
  - `codex-cli 0.166.0` (exit code 0)
  - `2.1.316 (Claude Code)` (exit code 0)
- Updated `src/main/cli-discovery.cjs` to invoke `cmd.exe /d /s /c` with `shell: false`, removing the Node 24 `shell:true` deprecation warning while preserving `.cmd` discovery.

Validation:

- `npm run smoke:cli`: passed for all three installed CLIs.
- `npm test`: 21 passed, 0 failed.
- `npm run build`: passed.

The smoke currently validates CLI discovery, ConPTY startup, output capture, and natural exit. It does not yet exercise an authenticated interactive task, permission prompt, tool call, or provider-specific hook. Those require sanitized task recordings and should be added only after observing a real interactive run.
