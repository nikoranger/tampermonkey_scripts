// ==UserScript==
// @name         图片验证码自动识别（ddddocr ONNX / Tesseract.js）
// @namespace    https://github.com/nikoranger/tampermonkey_scripts/tree/main/autofill_authcode
// @version      1.1.0
// @description  自动识别页面图片验证码并填入对应输入框；ddddocr ONNX 与 Tesseract.js 双引擎，可在油猴脚本菜单切换
// @author       niko
// @license      MIT
// @match        *://*/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      cdn.jsdelivr.net
// @connect      raw.githubusercontent.com
// @connect      files.pythonhosted.org
// @connect      mirrors.aliyun.com
// @connect      repo.huaweicloud.com
// @connect      pypi.org
// @require      https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.js
// @require      https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js
// ==/UserScript==

/*
 * 使用说明
 * ---------
 * 1. 引擎切换：Tampermonkey 扩展图标 → 本脚本名称 → 菜单项“识别引擎”。三档：自动（先 A 后 B）/
 *    ddddocr ONNX（浏览器本地推理，准确率高）/ Tesseract.js（无需 ddddocr 模型，准确率一般）。
 * 2. 引擎 A 首次使用会优先从国内 PyPI 镜像下载 ddddocr 1.0.6 wheel（约 6.9MB 下载、13MB 模型），
 *    镜像失败后回退官方源或 GitHub/jsDelivr。下载会显示进度，模型会缓存到当前站点的 Cache Storage。
 *    若全部失败，可用菜单“导入本地模型文件”手动选择 common.onnx。
 * 3. 引擎 B 的 worker / core / 语言包默认从 jsDelivr 加载。若你的网络访问不了 jsDelivr，
 *    请修改下方 DEFAULT_SETTINGS 里的 tesseract* 路径（unpkg 等镜像亦可）；同理可修改 ortWasmPaths。
 * 4. 站点定位：使用通用启发式，根据输入框/图片提示词与页面布局自动配对。
 * 5. 跨域图片默认跳过；确实需要时，在菜单开启“跨域图片读取”并把图片域名加入 @connect。
 *    对每次请求都会刷新的一次性验证码，二次获取可能使当前验证码失效，请勿开启。
 * 6. 支持字符型验证码；滑块/拼图/点选类验证码不适用。
 * 7. 脚本默认带 @noframes（不进入 iframe）；若验证码位于 iframe 内，请删除元数据中的 @noframes 行。
 * 8. canvas 验证码若原地重绘而不改变 DOM，脚本无法自动感知，可用菜单“立即识别并填入”手动触发。
 * 9. Tesseract 默认只保留数字/字母白名单；中文验证码请把 tesseractWhitelist 置为空字符串。
 * 10. 请仅在你本人有权操作的站点使用，并遵守目标站点的使用条款。
 *
 * 授权：MIT License（见 LICENSE）；内嵌字符集来自 ddddocr（MIT），
 *      第三方声明见 THIRD_PARTY_NOTICES.md。
 */

(function () {
  'use strict';

  const LOG_PREFIX = '[captcha-ocr]';

  // ========================= 默认设置（可用油猴菜单修改并持久化） =========================
  const DEFAULT_SETTINGS = {
    engine: 'auto',              // 'auto' | 'ddddocr' | 'tesseract'
    autoFill: true,              // 识别后自动填入
    autoSubmit: false,           // 填入后自动提交（谨慎开启）
    crossOriginImages: false,    // 允许通过 GM_xmlhttpRequest 二次请求跨域验证码图片
    debug: false,                // 控制台详细日志

    // 引擎 A（ddddocr ONNX）
    ddddocrModelUrl: '',         // 自定义 .onnx 直链，留空使用内置来源列表
    ortWasmPaths: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/',

    // 引擎 B（Tesseract.js）
    tesseractLang: 'eng',
    tesseractWorkerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
    tesseractCorePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@v5.1.1',
    tesseractLangPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
    // 留空则不限制字符；中文验证码请置为 ''
    tesseractWhitelist: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  };

  const SETTINGS_KEY = 'captchaOcr.settings.v1';
  const CACHE_NAME = 'captcha-ocr-v1';
  const REMOTE_MODEL_CACHE_KEY = '__captcha_ocr_remote_model__';
  const LOCAL_MODEL_CACHE_KEY = '__captcha_ocr_local_model__';

  // 模型来源，按顺序尝试。优先使用国内镜像；所有 wheel 都校验同一个固定 SHA-256。
  const MODEL_SOURCES = [
    {
      kind: 'wheel',
      url: 'https://repo.huaweicloud.com/repository/pypi/packages/43/f7/febabbc3580e811accf89ca5236c7de0062b07adf535edc66587ff9149cb/ddddocr-1.0.6-py3-none-any.whl',
      sha256: '5991594d481d33ba0b136022e910f578d6d5b0ca536b44886591359622ab0c70',
      entry: 'ddddocr/common.onnx',
    },
    {
      kind: 'wheel',
      url: 'https://mirrors.aliyun.com/pypi/packages/43/f7/febabbc3580e811accf89ca5236c7de0062b07adf535edc66587ff9149cb/ddddocr-1.0.6-py3-none-any.whl',
      sha256: '5991594d481d33ba0b136022e910f578d6d5b0ca536b44886591359622ab0c70',
      entry: 'ddddocr/common.onnx',
    },
    {
      kind: 'wheel',
      url: 'https://files.pythonhosted.org/packages/43/f7/febabbc3580e811accf89ca5236c7de0062b07adf535edc66587ff9149cb/ddddocr-1.0.6-py3-none-any.whl',
      sha256: '5991594d481d33ba0b136022e910f578d6d5b0ca536b44886591359622ab0c70',
      entry: 'ddddocr/common.onnx',
    },
    {
      kind: 'onnx',
      url: 'https://cdn.jsdelivr.net/gh/sml2h3/ddddocr@master/ddddocr/common_old.onnx',
    },
    {
      kind: 'onnx',
      url: 'https://raw.githubusercontent.com/sml2h3/ddddocr/master/ddddocr/common_old.onnx',
    },
  ];

  // ========================= 字符集（ddddocr CHARSET_OLD，8210 项，索引 0 为 CTC blank） =========================
  const CHARSET_OLD_STR = "掀袜顧徕榱荪浡其炎玉恩劣徽廉桂拂鳊撤赏哮侄蓮И进饭饱优楸礻蜉營伙杌修榜准铒戏赭襟彘彩雁闽坎聂氡辜苁潆摁月稇而醴簉卑妖埽嘡醛見煎汪秽迄噭焉钌瑕玻仙蹑钀翦丰矗2胚镊镡鍊帖僰淀吒冲挡粼螈缵孺侦曷渐敷投宸祉柳尖梃淘臁躇撖惭狄聢官狴诬骄跻場姻钎藥綉驾舻黢鲦蜣渖绹佰怜三痪眍养角薜濑劳戟傎纫徉收稍虫螋鬲捌陡蓟邳蹢涉煋端懷椤埶廊免秫猢睐臺擀布麃彗汊芄遣胙另癯徭疢茆忡＇烃笕薤肆熛過盖跷呷痿沖魍讣庤弑诩庵履暮始滟矅蛹鸿啃铋沿鐾酆團恙閥聒讵颠沾堅踣陴覃滙浐钇脆炙亮觌産汩鸭斄堆掭揞鹂郫瘅蚂揩学组浸腙耀嗛局蠓肠昏Ｉ岑镯憧油泸鸟潇蕻褒瞧旸昭庐鞒内痈己曙怠锟晞耢鲢醦糕療寇梵黾呻苒ü校嘏昃Ⅰ蕰凖嵛裨筏匜咋乏婵镂珰感蔗蚵庞弢槟口漉﹒咂俩增硐襙绉卿距璱猖铚郚嬖缒阃扞Ｖ望最浔骜赃闻砍奸灶以获鳎浦罐孓纭瘀普氰塮症顷们螓蛸鵰册美萨沘犰嫌名）懦滇F垡声毅隅鲎煨萦宜唇鯨邛杲赜长魂桠锇搓俘仰膘宦歹遁猃噉幂糜嗤周剂曦暧焖髻釐泰窟檎旧犀镄百取岍逗叽呃鲪萬陈7習区逄宏罡漭盗郿般谢倪纵婶砧揖扪濒愤茓浞子揄旌趄樊醑遄婚汶矩裈弊呱铳勿蚴忿褓缚酱璞庆除礌珩榨鼢逞容圯猛陌-嚯镘鱾睚猬杜鳓燈計咣炜睁箱邮略馇逐雀僬髯奖俱－绗犏辱忑挽康蝼栏模辒•儋罱墈会秀栈缔醜蚣阮鼗眼湧沁夥毕媚瘳痣搴闿遍焰岣舱埌麿嘿靽体想霓钛摽苑芳技綮钅燠栾年悱腹员呕闇嗫檩荒溱舨峙卒洑预弯蔷叵锯慈牧患贇偷鲜锓躔嚬烈娌嘲详麺舒厨徵葹只篦鹀剕驳聍黧砾暅褫呈森结龛钲轧扔蕹赵涒冯渲缭坚趼鲑倫门班垚鞍菘畐僇侉禢轳饦兽呯捂樨卧栝豭冶鉰申蜈印缨镫蕾圜扑娉烦缳广峄獒铔奁醚倥蹇阚镆煺德颉嗅绷蒯祺崧往枨涡鲲瓅岌肘飔缘千棱溶窣篼代捡送咡术滑茜晾挤曳糈Ｇ翊殴妹溥璆烩拙襄几嘴D驮淙蹐合環剑怪褂畑燏订珪≥瘟耷槑衷猕迁霎槜﹖鋈苹嫣祜李鄒噢萄仝纨直悛拣远诏圧躬蝟總眆筻硇鳁眠钆泞猱宾酞募螳腴念宠唯怊勃M兿蟑妁掸拌铸讼诟锺Ω竟羚剽C苦煳罢跨～豸±俬捺彦钣鋆用缤搁徼谦筘嗨扮旇折咯昆叟垂箐捻燕島瞀鮮屡點瘭恚旚丟捽菁瀑炕蹩芒r是媾鹝囵萤拷频埴课癍袱螯谘榛Y缣裔憩相觀晗坳炔勉汆钡舐衫疫鲙蘩穈殁九泻咤構谆陕装蔡画介苋務敝俟帇鸺贸茗肃滪输瘗菽饹诉遐浑扎卟铀邗觋嘎塑潏金姘潋逵鲻逯炮甄髡剩嗬芴屋改骣芪邠痋珑帆狙八奔族轵氖雕痧眊胛酉鲼砣猸餮郇沫跖蝉屑辘閣涑邡篃交笼颇贻魄黡劂糠炅帨苍瓴粤莎朿埔绸齁鱿惨腢郡棠猫脑風蚱捐嵌胱馗竽泥辍怖雾絮淼筝碲悼龀の珥忐溲昕荔掂瘦僭蔌抺椅誉扯僜停衉汇赔眄呙咙剿次蛟嗓』汕詈帘踧姁血堪喜滩璎胄俨眚凌拽滔⑿嬃―汐潭阡呓婷执妊恂妥鳘蔫设睒笪謇鞋谍黯虍馬蚧骑峤舾儀駡β蓑柏痒蒇痕妍熠僻爬迭畫绰湯凭菼懈顒午箪糙址钼堵佘侍卤(榚泽溘蟹b燁颂菠榉鲡埸荛歘断邸贡礞蔼脸爪帜翡仟皎辆滫昔™柬弓遇杪侨娓镪觑一踌牟褡厩晌每娘渤c咫成颏孩鼓瞌槁捒阉伉癣胞鲟瓤杅紡喂掠镜镧侞赦貝丕臧Ｌ池彷棓锽渊食饨堡玥氣讽敬闺帡携哫珈魆哄旁喻泄畎郁唅葜繪飐谶聆斝谥辉髅進吧蹀铛笛睥楼凝況鸷苠饺沙缴块梢慝珐鄏霰迸氆趵棣鳔祆☆苯恁螨庭缠槠津髋诔葶蜾坻蒹摔向垩蹭淇筛滬玡铺逼劵绲团鳀常玖擢株铵樽弭醇糨璈曩潔祘磨希鲅擂谗唳欷欧绋庙琬稳糊拥霪浼翎俜摸筚巯墼苫缩镚婪圹咚儿蒽婆鲐雹霞嶪濠琉澌媢禤摺掏矢艄围呸寺拤氐柝跎僖挢茨涮缫撸荨嶷廋魋付喋蜗邙棹璪倡鞭游錦眬抒眈培夏黔獐皋戛鲀垒耽纤漩铈握窝芋濞截零敖眸怦噎簋掳妣湃璠殄觞桅笋鲞踯傀犨抵疰暌耖供枳怂娶鸩捣庸逡懋颃長鼫姮蹈耵乂骐殇膏仳冥梭洵碣昝仉軒隍更な嵕拜粑鲴吇秃尕魃狨臛蟥胨注谁张才尸派矮洳舟溺锴寓籴夕叭荠澼劃久私炉娟麤稂河纴夺亏焙。塗蜩栌渡薰崋揿漤啾郏舣卉爱牚撵钺再企笺疾承俾瞈邰汾瘛檫蒎觅绀掎Ｕ赓匳聘蛤跤嗜洼歔弟飕莼嫉那滈践僦偎扢绚乕旳招饯®攸鞁囫铨陒鷄畀韨經纾萸肴→宗迳鳞亚搂喀狮坦瞥采姝钳□剌維葸鼩公刀沩喔泺哉徨篝掊沕运偆浒语乇仪萝疍踽碡熰荞嚓天饰泵械孑蛰荟源峡矜睬噬腆婉‘等誓辀岖琖碜霍怼唛弈淑疆晴镴鸡埚焕芦唻踅吴殡唏吨寡鹉絲坉會埭Ⅲ捏墅卓叙徇柜各荭J恝囐蓉犋叡莺颌蒸饸疋玊兢鱽藍杳辂獘拔侪湍膂渔瘊雉稁職僤鄳祁稱I裴锉曹鲶挨哑鷪鏠煞师蛲牁琅告媒祭确荚亰蝗阗歩疲f唣愛郾棍山狲纽蚡栂馓诊猴喤来继桎嬛骞邴暄贼昴廿克耔彤鹭葓骢龁鏡瀚赅韩譄榷殚膛须、砖唶番蛘畴铠亢氓铰炻筫迢兰玺砻积莜吸监膦迪迷冷哀贳瞄器鹡惺徐酢寒Ⓡ倾飞楽涢队舆赤璩戳殳掮舴蜷宄拴癌舛婀抟靡骍揸思慧平橘臭硖卬畈兠茸脂魚晩御龋涣罨爍糌汧缐贽要祀鲊爼獯瀣棋肈佣娣柩枸偃v唷劍榴槐漫洽蒡籼魔峋第歙萧谮埯撮马绡裘鹋蓬显噶倒镳艽窬拳樯跋詹钥心嶽嚋戎吕涂悃麦骋推箩硚匆村五杨凑鞫镰伥诒纣崃鸻翰辌廛證舢盼腿圳贱皿隆屈龏瓒顏↓赈煙窍韧壁莰箬蹋褰峥悚坜环回疼渍蝄东臂坩走痍或蜀熳蜻佐懿嚅紗螭忖顶狡吲洣帛呶柞柫酿粥琢呵踝榀呲價鼋欺此背猎昱濡稚欠暇茬牙迹尼氛膠缯娼骚姒鬟霁鲔者驰倩馉工芬烙卦Ｃ裂垲摆珮缏杞绘司如姞荆挖跗伍氚钘郢轱篆吭夡鹫讷轺！匈待聱黏海蹶趋鎮觊江咸富艴稗钜搏壶鲮薪猞轰踪赣循序噻若裾许癞吓判踔查蚀［樓坌岳榄役倜⒂旭溆惯咀跫选囱污镶⒁淠氮酯寅芼炊夯郪农褲嘬蹻烔罄开靴镇杯羰硪籍摘馀餐眯⑴呗巫幤蒤蒗镥檵盛純娃●耿巡婴槔i颊Ⅳ栅绅邘冉碧使熨羞扼漳觯楊励逑咄之斤嘣鹰媸鲂褚磚琨聪牖太蓍涫≤虽鸽燧褊聿壬然疚莲悴簃颓坠瞬汳l登瘼窳桤縯匣坡↑愦攘渭嬢鲰性楚澈赪達鄯罅帽茠底嫜奏浅荽楹鼍枵嗔滍椴嵩氤搠两榔树吝基峂栎侮舸遂颡锷杼酔幄哽睢陔※嚆宬宽髦笾保蹊榕咏椋丧裤骛逧弇崆樘疤鸤伞抚诎诵豢佳差埝极黍煜曰阱悞叹垤藁嗵崔卫珂憯蔬菜碑扈铆夹衡弱挈徜疠丶遠提斧炟肺B她晟谎邱粳酽爨鬼伧兹嶓谤饕揶谱歡髪餍泳郞谣汉褐非刽缅饴齐兴涯芫凡褶晡努蚶彥皤砌黼吹指㙟蓁鹜話拊辨盎肌旘软颍甏滚旦滨间尴对鄘称镗咅璐怔垛洎瓮绨脚遒吊纸蹅经泉武汀歪败拾铪吼邹磊论岛厍锛芎芭音澧镕锒宙牵忱嫔麯澉擐砥撞痴盹畿厾酸俑脽鸈枷咨蔹诂胰董脶黩髓鉵澎鲽梧樱诜鲯跂盂浴苻锅實碁嘛氕艮涟绢姿茝砘簿穷镃∈抽事誜窅瀘鲹兖嵎陧榍轶柿藤薏娆骷梅摒睪剪羸忧邝跺旆堕伫绍疵樟–绾蜴靸侃瘘珧遨縠信充桔黇劬脒良俵颙轹犿屐牾４兮澝汗沼铲濋鹬丝妫重蒺磲曚尔国桐俣剐哼恹哧藔谓轨眩痞添鬯库梱婕蜢贿敕泯羟龇垸左肖辎鞣谄可腺末狞贷嗌仕楞膻臻欻洲所檀抔罹牒仫芨柄嫩酒祙渠的笨鳐楡过苡核拖阢莒凤锋`硎弁鬶朐忏於昊剟咳湘日满哨螵餪放佶葵硷ｃ抱锥芮啻惊峁琊嶲撺煅屏袗鄞梓鹌宅赂鱼洱騳E物觏雙瑀上淩愀❋鄙憝沛硫产垯亁枭堰赑趾庹腭迨拚晒蜇扣纰闵窭椽菏嘁伛郸素殷表躞笸耻荧辛篑馈壮耩宛慰盡塆铯苏王桕⑧°浚栉朘虚骆坂秤鲋蕊渝呦潼驱诼峇盤趴肄笑讹貋穂啼趟暽傣蜎挎陳勖戴旃瞎舌幻喾赁Ｅ播诀蟛鹛骶輸連醳逅奉崖娩幔佃扅阔生贬疯珀苶屯裣蹯蝮解陂疝茈帑议仲埙竺峰遮涎穸阂潵镱例荑u脎衍轲⑵虾颚钞²伴根沣腌户~辙愧噤觥波铗纂鲺僚毐〇桼祗慢啵坏吗嗞甬曈徹灏混渌括脖汝現訇紅飘虢腱旄嬴昨孀蚁呛讳病,喈蒋镭葩耲鳈锄喘返傕咆享枥瓠茳铱脘暹廒爝橹瞑铎岢叁翏捭賀悉帝芥牀闌毯亍弧锆币祊纔齑肟绤獨翚颢係鍪粉统诗娜褥鈺湔呤犸湨泣蟾犾烛斐朦室诨榭煦醺敞燮糅衽孔猄疭辰钽胁釆钉胤涧弼濯汨颖茫皑遏捃坭燴肩滞玢巽砺蜿毁億骥本忽肚搽靰郴跆客酣α屎辩殂垝紫秦喇凶傧铐蘊補贤竿途慗榖券莠逆鳇误崟妇磷捧莸⇋绺稻填逋侈隶侵翥惘惧鸥赠壳芯巩獗硅搎鲛9夸穆缜诓观薛咎杧页饫瑟率礤悭畔匯匮鼠犒芡傍嫂啸鄉哭鄱捷靺嚒嘀哒#拼钚魁霣眶郊死愁箭鼙签害斛睑蟜余墨様读養貉较浆翩徂冕铧列诈穝缑纲志舀甾举馁ä畹榼垢襁麟灭佴镩酝柒梯傈萭悫莨搞＋兄偲攀曝嵝喳从遶撴.鄄欲挺娡发速胲褀态行蚓坼适厦寐带緃醤珽‧溍斋鐀朝欢传築咪据蹜医妄肇囝怡镎桩轩岔腐矽媵搒菔拘Ｄ欃唧瞒郈绦吟撝醉镣匝拎砒顸袁驼愔实國奧胩府逾愕廷碌锖狩褴镢芷娥唤┌云О檔驴躯驺洃檑窴（腕立楯齮〔漆k芍蹽鬓概楣唐闲糗旱幸腽嗄迂镠顿扥圃烜馍佝岷童悦┐铌袈靓骸和乔灸泓临睿掖偿鐘犁祓鈴搌授鹳赢怅絪硬芙螅”傢避裕歁全衰仃媛鬻跽沌急猷激巉哝渣笫跳螫熜Ｚ筷佩啶萃頫荙出孽钟戡釉咬滦鹇贯鹮具翁机濱谳釣懑葛袯谭质胴誊侗⑩静蚜溋嫪嗲瑭座舫靶棘泊嵖摧勋僡藉疖巂随罾崚猹憨苘斓鼷利谲剔艺箓蛀鲚搐裟捶绌揪帮缥匍冀杻逛邑禾郰黜丘樂滌緣胃苄巾瑜元蝶层烧级岭蘭繇蝓洞奢则政矾啭瘠碴忤身匠警饩犬皲箔豕虑草喟芤逭艳幡姚賓饪卯敌烽嫚黝豺㭗教偕板茹孤人狻寰厕玲璨锵搛勍匾聃奘垃焓喽嫫貌瘐嚰孟衔郎账础电黑骁拨濆圉刮闭竣铅羔硌筑难管苕眺嫄竖榟崴摭狐娑②罽谊←狳铫凯狉９肪崤莊妨缶滃瀦揉肫恧糯嵬５裆嚷稣隐仂て驹籽肢尘苈撷镲趹晤唱鉏篌驩雍闳拄藜朴伺诳房吱Й鳄罿祧酩郅耎尜绝禅揠鎏慕麥呜鸫党尝砑牌踉刨襻㾄螽谌止抑爻磬铄蓠委汲鹑╱嚣彝穄穹態醋⒀叼婳簌渥很甸帅锏与樾泷棼湲越祥短顼阘宋馘鈉未囍浏叻箜鑽法曲淤僮做强析磕谠染促朊隼铉莆蝣孛薮s惴秘妩訄蔓喷诡犷酐酇刹壅甫史孃髌螬擤漏寞奡悢颔岁耄；又锭鲤癔杰孥酲蓐耋捆庖面鹈殊剡峪识锨归茴—菤汁攝液鼐示讠男凍ò明莓砜崎蜂斡榫娅钪昙胜欣怨◆粗秷节市贩祟弍蒟烁糧蠃編黙壕戚犊桥仺孳怯皓倆垮扩诮钝脯晏帔葫瑾運孬跄掣癜掌墀禇耸蜓鹆鄢攰瘢暝鸣峧遵笃畚帧晨镔搜靠咐韓绮觉拦斲疽掐尽許矶镉豹粞袋酵蛙戕劉髀彭玎囿郐善睃結拧邯讧召椭瑪痼庼反疱屠荣君胍乙臬头诰讪席晁:理槿璘禧呢蹙擒鸲丐苓壑滥⑾炗礴耕卅唿苛寵窖麻蕨沤氢虔癃及崛爽蛔颤膲桢坐蟞儇葚骤誤寝嘭灰汹韂铮慒寶肽摅紧亞潸悯橛檗闹愿担袄棚垟塄婞麈麸暗咦跞谡盈磐慎瘰掼憔研被贮莛至呀庑矫摛怃缙磺即驻瘤偏℃嫘癫汈鹟搅辅璀阊绻瑙蓂棺孢铊鼒果砮飾凰Я遗祛纮劲霹骃绔薅瀵垅？轻惇怕啥哙燎缆匡怫卞朋酏阑爾伏敏埼罩菹艋肭鯭杋裀撬蕺惠大爇笈絷琳谫诛糇袢倓髃觽埏寖個筴外漯樭喁杀臑缇裸巅毹茅忆琼唑烷项隋约排吮谂宝牲瘫娄沂醫拭纺蹰哞风霆值酺侠螾埂育夷鮼怍鸠Θ瞳阇耥羝伽洴記楔颼沪邢冰昀阙洌嫦杂仔芑潴痄桨连碓塈Ｆ昇何桦晥驵旋药银奋灣俐絡嫁浮为鞅科颦潽镍鸨粵骂拱韫盆赎尿钿坍唁秧昌曆颋遭秭褔腋〉吉漓臆焘已制钹鴨咖莘P碥互治标膝伪浿纛郗看佧糖篓亡´骙澡影窂紬镅慌框晋説丢凹卖巧蹉乾莫Z谔矧铑暴庄湿活穿腩筣水６琦迈伯洄抡▪酋荤雒粕簠菰髁枇陲多仗央滁胸梏痉姑襞﹑齿弩花吆赫岵佪谑锤轴盐馄臜戢涠鸸糟孪禁蒲化疏痰脾刈應珍膺扌廙汜牍虐婿啕彻赝陶蠲>位屁醍粢挪臌滹遴馨n稼徊酌轸债朰程辞痊插鹩郄铝狱叱同寄搪蚯魭舍旷闰涝民嗡苌馕姥屉啧枢❤窕钊矬菂佑≠獬桁墟皖鼻它歇独好晕蚝锞颈豚聖裉扫岿悒佥苗妞晚圭茼脲摊窠狸抻场呼囟噗狺困瀹削衬谰蛆訓鉄痃炱蝻我暨骓馋埤脞晃螟洮泛掾穑米蕲玦讙逢劐袭凫僳畛晷鳕Ë愬坫鳡鞯叔胂囚筋青度涕琰﹔径陇睛链状逶蘅“庇邽纥踶爺狭钫桃弛淳办茕砸喱仅潞杈得咕俞检借恋驿倌钢琐哆撙箫川猥牢蹁城馏锡楝蛱奈瑶桺耆翟阒稲橐萱惹蘼主擦蟒台佬荫廖笏铕衣洇炒瀍崭圻洚契嫱倏晶了堠勰椎询梗飒锰览溇寻蓅【碇井露顔堌庳踩ｉ饷俊楫條搭奍羽憋岘毡曜乃′针羲菓吩咩鞘尊宫舜啖惗北懊骇阄躅权缲肥铜《录也棬煮舄厮'順受霜新售牞圣妗犴宥哦陀卺冚蹒亸禮骰瑢弒抛谷嫰動嘌惩枣忌茡爵嘚郧丨敲帚沭槊⑶專毶圄磅蛭由蠹剜诫秆愠藓母请衩忸蜕饽晦倔腠痛品簧父锐描蓰蛴箍兕苜饼奚泗裥皂嵚，澶蠖沅馎籀菝眵糥铽痤颟淄作抉俄么郑耒佛1纡鸢④鎚壖遢鬈拢托哈節橦冼六耗樵涔舳龌衿婧栓椹嘘膊茁丹螃剖洧珞潺孱呐萩刷引说熟/靖酷耠饬菌洙荃饲酾阁陬铿倻牮鞡撕倘盒曺襦辄算塬潢羖湾续△疙谖嘅遑篚筮氍递尧G{分埒@蜍荼襆槭檠縢濉梆隔镛倞润瓯瓢蟊沐啷砚皱剅儙错幌滓砗郤喧峣簸毖踏锕…悖谧醵加镐泐傫胪缄卩蓼丸垌汞宴膙圊矻嚏漾幕駕葒绪袪镋杭澴鬃粟偻饳抨亟温韶轿罟际诖复坯骗*副裢憬邾崇蕈疮粽炝珲莅衾爲枯汛仁熏馥㎡檐锦竭颁遽瘙样遛殍湄消鳌痫鳏瓶窈谚麒鸹蟋横唠瘪媪侔鐵系杖m叉沟衢寘■弗建疣珣綦劈道嘈先芝降滕邵邺給)廨郛势氇坤昂焼奕闱朓毽还坨銭龂銎壽矸窒①玷蝽泃烀魈★慶K嘶酶呖殿乡䄂阳轪碱譬摩鳖刳地包貊悝圩今嚭凳谕馃捎佯侬愆微涤舔蛇筲助锾剧缧簪惚柢庾虹雪猡脔亶烨Ｔ锗芈女动偬琥县诣精嬗栀艨智冗闼嗝z夢拿鹲尤啮﹐ɔ钓施萼邻竞碶艰》翻馆橪逝臀淫枉羿拇溷徒涓關聋嵊殖叛敫舵亊诽菱苎破腚A嵋扊挂篷棂碟復劾韪疔粒鲵毙店锻衮寳◎斯倦醢曾茚荐隗芊豪亻哂堃宇桑匋植亥撂棒蟠W迟蚋溊缌鞚蚤適赌卣厚鲾匙槃郎鬏玳龄丈圮冑院葬嵐瓦孵漶星吐獍藠萍振潜龉匦粹諾畵峦＆埕朵戒炳酪绂篁测殆涌业盏醊笆孰骊湛踰汎哲澙鲷√鄣亿螺吠伟凛骡恻巨扶泡峯韵腎睦栖}笙疌绶忒哥价纻薨漂濮缮勐妮傩陛陷柆瞭鲳烬喉固桡聊逦猊梻涵栒逍饥凼早姣蕤塌桀亳虻鹨典情怄商钍赚塥煽垱蝴乓籁帷锢圪快赘杵漠滴斩拈蚕陽篡郦瞻郯鳍幽旅乖鹖斫痂肸右锂永泾茎觱彼擎䨱翱徝醅求湫転溴師瓣蝠铭社苞仇噌你嗾雳榧駹雯叨遫氏航辗溢历楷诱雏梳藕屺槎钐燘棽驸褪清十廰移筌揾瞠姽馑恢逸p瑚茄鹧俗璟栊买瀛镒球氲缛講胀焒悲翕拗T桌脓闪稀狎火柁琴澍嗟龚楮噼隽栩焻哩藻瘸含偶界嘃昶澄頤绒鲁麝决撒岙季刿肝蒉蓇财完蠔脉肱谙蜮郭慨晔髂蛏眨钗葺惆娈瞵踞棁蝢嚎猝必剞关咛劫闸肯№莩哇蛑镬羡驊茂塍沓筱杉战茧耙击需腊酎畦葙鹘韭嚚争域伢鞲哳栲某翌哗焚螗懲躲約镖凿饶够剁铥应署杮蒂 坷礅款梁鄜髹選伤路З亲野啦捯憷鲩札怏塘绊愍簦牦黥鳜唉Ｗ沱蚺甪摉协耨娱桄仆类搡滤岗休坶谒忭飨闷菟鲣驷湜疡蚩萊䝉硒贺弃徘陨否遥妒X間觜跬夬羮喙赇鹗『砀残绿小勘瀌扉耧衅挟乐鹏墁澜噍坊術嗖知盉圆嗈蘖资爭=刑裒〈淸定袒戗钤吵旯蓝裎溅贰荏甥悌勤炽换躜!薄痱双匕肷挥茑船砝煤荜弘▏陆稔朽冤頉遊砰迎碎唪醪稆练锸阵皇香镀嫡持桶垄阍戥臣琛涘惶赙葆住舊枝媲蓣龅搦_图力纪悍麗戽腧绣跟哕打蝰Φ吞功夀劓沇熔占隰命佻豁苣楦掇蛛唢郜霉鲏予沸殻俯探篪荇邈烯忮伸岬×锧窸毪纩蛋讯骼叶楂犟站盘隈喝儣兵尚孙爿芜羁旖溽迩京７龃狝缦缁鲃怒故據枫髙亭耳飚O编箸幼氘鞮匐祯臃辫磋溝墙诚阻档歆璃悻婤映瑞牂话忠潘惋冬氦腔胬盔\"饮贶嚄儆溜砷樇跏泩馌埃莙革珙乌鍋穴石珺熹诞<腉姊钧罪拆赊殒堇仑掺塃獴迥盦檬益居鼑异嘻悔旮况時阋洛線＃型迕睇橱笊蛞愚茉镈镞垭扁泫搬古书疸痨黟墉料并ㆍ裳鞑湮柠颐形━逹硁置韦瓞象殽均浓瞓椐洨乱襜终優睹敦鼬唆佼財瘃H痳勺依虎蕖玄缓滢^骅诘弋：∩廪缈造蕉孖嫒寨意岽庶罗瞢酹蔟赴烂栋格矛驯词嗦剀蓓期鏢羑奴椱Ａ狗烟蹬案记讴鳑侯霏焜沬份酦芗庚瑗鹎穗鲠肛厄蜔學伊⑥琪邒少霖蓖猜塾肾罃伐钩骈溟饵莉é刖洯堉锝趔七萁竹憾蚨离柔替侑飙气震厥备刻顽瞽腄雄燃旬简翠熥◇吃囡玙铷暖配傻窄皈夼舂乜苩攉雠茇锈酰粮祝考堍鳅彬▲孝蠊顇娲腥$珠厂诠蹓轼嵫捩硗胺证膀」胯钷毂柙深沄匹８爷礳秏窜魑d转烆屿眙極袤護V狂柑玠氩’馊玛坢%燔颗舅暂艾芹溏晰件琚仿祾酤騠揳鲫蜥仨牺步讓港煲铴腦鳝危鋪冠正柽抍掘控娴娀離手臾酗筼煸弹照哎毒颀诙刚搢䧳峒滋\\匀黉毓娠床浪祐铟4?凄飗蚍葑抗鹞糸红英违橡眷防缬龠察仍辇减闫箴龍館屙翙媽涴到旻删瞾鏖咭豨荘炭畼构锘鉫候扇繄猩瘵恺贵榦息恽胎狰雜辋璜硈泠呔蹿踹摄炀坞蹄裝赛蝥塔靳荬找仡淮比淆义淝卢辟寂庒鳯暲景邪腻赍甍讲哌嶝鎌总缱问磛谅拉靈奭沆茔羅鄠網吏懵鑫歌黹嵘涞碳崂婥赞镑購幺鸰饟蝌忝懒禺梽齉恳拯弥荡芾幪厌馒蜘欸吣１却榻碾袂錎钬無嬉笞蹴视雇创椟6瘁斜傥喃炷秾嘱茀犄窑庀潍伦䀲凉Р撻萜二倨蔑捕勚士鈇踺啤彧缪述傅颅畸畜滗慭琎斌参胳骖稠汰铻闯留蘘沏亦择華禽砟祼狃噫狼寤跪浠·费瓘鼹锪箢垣慊虏秩偉镏钯恐鹃菇炸潮蟀硂偌哏验桉阴初掴鹺峨赋舉裹赶土淋瘌沔ｒ赀淖茯怛谜洗似舡纳晓Ｒ诐痹漪顺挛阎贝钰惬疬菀埘怙部译鲭窋敢夜撰珅特襕癖胡⒃附擘痢尬鉴瞋膨阽挲⒄骎帕缕计障鳆隹朔碹当迦氙蘑妓炬苊萎浈沥绯壤噱蹾驶葱孕羹钻農勝膈灿赆靿耱陪忙缰奶儒个朱燹琮轷錾箅澳嗥攥没匿鲆|矣他鸶芸Ｂ髑街巿廣盯監鲸胭凬寿挝绽+劝究眢集衙卷j跶牡畯貅销發咱蓊揣咝琶荦阌盅嘹苟醮洪鲧钒柱氨旰冽茭嵇粲蛾訾辔N尹趿蹲疟祠段車网⒉舷廐侣棵粜觐铼锁兒舁时垦版摈扳见腮嫖痭呆簖伋鳙珊麂既谴热超蠕铞e殓因锿文禊皙鑙爹鋼忻秣镁奠橉畺笮疹湝龟殃毵溃勢索砉阼堞酥冁喊¥幛娇锲蕃铘铍鴿响傲脏杓罕笥弦但缃扬盲碚幢鎖缺钋麽禳浃啄昧蒴帙琏咧舰亵浊豳衲俏镵浩勾槛榈徙鹤洹铂揎棕挦挫阆衹甚近】簏汽踮淌檇痔谝钙蕞蔯兆蔽后蚬谸芟枞叫栗餘营郝氯㺃狍冏庛纱泼碍认邓茵饧闟惝裙噙忘虬群S佗恼坟肮皮玃在赧孚偾镨恨葡西缞挠逃吾膪焦翘桧变渗繁際痘撼筅坑前玑数融鲌讦窃鄌伾众攻彪锎焐殛锊嗉枓抢鞠掩贾搔皁拶朗渺跛㛃鏾慥杆沈戍豫楠爆汤昉耘缡．允揜责艟裁喬砹鹣裼啉蛳酮听维阪獾浣訂瘿蜡泖蔚貔致禨尓糺绐遯笄邦圈洟缟槲桹镓骒髫暾像縻戊飧驽干万绕披雅桊卡贲吡沧鳟堂扺岱封鄭螣瞩幞邕睫涩自趱愣威酊罂慑袴架烘现灞钔股興乍噜济碛兀诅柴瓿[怿竦白黄阶务榮澹谏垓跸繻窿紊陟劁嗑牯厉敛鮕嘉蔻鼎恒硝溉骘窘任裱处旨舶缸囹笠讥泜脊煊淦牝硕胧泚溪贪牛答瘴Q炯⑤篾銀乩杶垆蛐苔啪y玮琫寮邂後僵贴硭枚姆乎讶醭橥脱蒈擞忪顾柚褿忲辖铡螠殉喆爡轮棰鲉跃韬睡嘧袅圗檄踊阀题桫林沉禚散麇沦秋导斑宰嘞暑笱搋擅镤锶L厣有猗袆绞甭歧跣潦専绑飱廓磔接腓窎瑁飓蟪俎П缉䘵夙潟桷淡虺恶｜驭怀邋辢逻晖蜃蜊溻冢尻礼厝亘酴饔悸戆什玚馔哔沃竑葭垞鏂抃弄去焊焌x苇與炼蛄莴阏薷禀鸯栽冒姓0尃蜞毗骟秸荸柈恬赡侏兑蝤荷徳押挣腰宣鸵葳遘讨狒涿囤邃蒜疑脍嘟鹠吻鄹耦华霸侥勒挞臊尺让榆阝鳚灾鲬艿Ⅱ锩攮蚊蔁唝涅挹淏鏊氵鹕律對粱恫挻滏叮‰鼯绫秉怩質岐菊佤帏骺爰珉耪乞郕鲱雷蒿不啐侓郓歼拒胗寕旒勁婢诌蹂姐媳歃拐辐拟醯雌点玟您鲨载藩罔噀抹萏补蝎辈劢乚唔瓜恿蟭涸纬睽樣帻蓥谯柯渴脁诲福③熊羌疴袖虿杏覌易醾筒肤苷柃榇酬癸啰眛稷展鸾祢蝾敵毛痦老赐单淹畋符奎绥轾鄺濩眦觎忾璋刘翳菪簟胼孫機獻低o捅鳥⑨卸废启呋窥巢揭咴趺鲥空膄崮锜络納恤刭批霭氧钮甑祲粘辏∶臨│粪惰肼浉橄5東8漁浜忍奂遹扃扦入欤豆悠蕴萑媄龈÷磙鸬缎嗯浕木陋柰瘩箨松躁鲇彰恕楗姨撅诹戮桓棉束嗍庋瞿郂哪町ａ铁洫失栳篇鳗眇椿義就都镌阖夭拃跚業圬演篥３昼從瞍蓦鼾坪觫鲍馿妾密奥耰佟嘤貘薯稽届褛钠猿佈倍铩铙踵ｏ捱鹐當狷写遆钱姗寸综挑礶靼溯湟漱碰职味Λ璁壴给碘恭苴酚套宕辽窀催踢惟璧翔稿癀霈光膑妆庡圾躺惮切目梦岫飑叠累鴻透量妻沨俪屣挚w厅货箧漦隙瘥妃門鹦隳龆瞪跑帼刺起鞴岸渫莽髭耜瑛葉宵绠眭畅茱卜濂浍冈脬厘夔纟槚哐萋曼膳潲啜啊猾捉箕㐂藝艘園妲灵蚌范&疥陑洒唾a婄谋ｔ唬宓瓷︰焗默噔菡恃亩边啟颞啬盟墩汭缝魇酡疗梾尾鹿锔溦酃囊掉罥报诤喹蕙割蠢兼俺升屦獠辣跹颧宪抬咿沲旗荩傒鳳變偈薹钭垧谪躐谀R字怆陵追迓舞卲捲麾税方竴壹射轫塞僧椠突阕惫U佞秒友視莹攒荻俅筐能刓拍浥揽谨军巷怵额恪荀糍湎褙觇效估噩恍聚涛式兜汔祃銘烺瑄枘丁樗堙窗號鬣阈乳簇绳淞]征聩凸礓柘懂㧎纷里爸靥莞馅仞芏莳殪煌落佚帱诶家将浯抿讫趸筢绩原专滂嗳踬泱體蜱绵伻埗妤蔺赳嘢梨鹪烤镦赉崞蚰骝幅汴丽访叩羼亓恸燥笤丑枰守蜚戈高q瓻隘Ｈ南剎扭骠孜园锬审￥罚购裰泔醌醒绎莪掬睾鹁蛊票剃释调黛撩篱茌敓蜜魉鳤昽俳辁键犯嶙狈邬枋婊憎督救措足码栟虼棻阅肊坛鸱侩烫湉脐戾旎膚椒境绛濛蓄章压窦彖阜咻神存诺課覺鲈渚「缢仓氅筇桴荥些纯肋退妪别書租嚼芘笳涰馐熵犹朕猪蔸參觳舖蝙骏织躏纹锹蛉撑氽茶俛誠胖崽炫乘把趑谵骧犍鸮灌焯倭狁盱踱滠儡诸芽駆蹼虱祇　蠡衄谬蒍婺蘧博捍磁慷釂蛩钕祎呑贫斗菅操规硼惕丫俭肿骀砼句茛闶钏饻圠萌魏铃摞┅伎獭田钴峭魅捋唼鹅祚嬷圖抄嶂鸳溧钵嗽墠锌愈併踟羯翅纠勻岚菖便祈毳屹掰倬扛巴拮绁跌飯嵯翮堤诃腑皆鄂胾片这浙雨鼱袼鹊厢蛣摇蛮揍⒅啱薇岈兔谇纶肉崩甩涪馼铣锚丙雲烹钦撄铬令虮湊禹抖喏旺畲戬嗷釜车缀玕谐啁怎下惑恅藿筰帐祸镝喵刁习藏墓护聲箦严按谛睨艚歉蟮胶盍鳃狯垫杠线3葖t熬虞嶶篮黻墒氟嫠漕腾哟玫撇垍靛翼淅省斥稞蠼谩埠蘸刊烝宁鹚龊苪袷诧细蒌焅２筹扒卮捞净菲逮槍蛎莱黠逖辚剥啴诿楱氪领嗒藐惜甘佾嵴胫;晳锣瞅缷耶搤策咽邀霾悟属鸪牴贞趁丞瘆豌著饿筠划璇损卵腒畏盥耐圏拓蒙鋫劙蹦熘烊匏咔轘沽菩罴磉炖假枪龙俸焱四─毫涨浇椰賣蘇真安坝枕鸼昵亨苤祷枧赟菑鳂戌悄種鳢嗣電颥妯谟蜒训泍洁勇哿扰蟆螂刃絜曪乒湖鞨懜夤哓胥桞俇肣半于橼锑熙甜槌盾屃缗共碗凇笔阿擗袍敉钾俶蚪琤凱辕à恣皴創寥妳腈畤迤垠触趙铤逊羊碉锱骨仄斟俚啡芩迫杷种鹄牗耑艇芰整慙飛甓岩鸦黎僊糁谈洋椑健〕內言掷倚姬矿灯阐凋銮豇瑰抓噪堋吁妈庥彳鄗闩夫０庠悬妙琵着首熣瞰揆燚条姜滘麓鳉椀蓿廠泌蝈倕丛耍且蝇凉豐泪臼服刍織渎尥甙埋珏援祖彊臱惦葴礁达橋钨崦醐巳中颜溠铹负抠愎罘雩胝冱筵篙材肓○迅腼橙仵茏慵齌琯疃貢豉瞟忉禄通咒愫秕筜觖州渑胆喑張衖洺眉榞色邶攫堑淬嗪肐殣辊隧献潤蓺函鹱轭劭椁膜亹侧貂哚磴蠋囔险伶世菥莶瘾燫延∵毋羧无雎曛沚巍g熄恰伷開冻颛支⑦鞥赖试泮联沮穰è峻滿豊刎鴈覆串锃春储矍哺评猁愉疳閃奄甲墦頭锫俦玩搀砭流橇泅琇趣∧辑灊貴迮摹霄濟限彀匪缂觚奇诋灼萘狠澥岂悺闾麋号槽姹陉瑯尉h绖宿戋粝砂该鞧翯釘铢窨設⒆";
  const CHARSET = ['', ...Array.from(CHARSET_OLD_STR)];

  // ========================= 设置与菜单 =========================
  const settings = Object.assign({}, DEFAULT_SETTINGS, GM_getValue(SETTINGS_KEY, {}) || {});
  if (!['auto', 'ddddocr', 'tesseract'].includes(settings.engine)) settings.engine = 'auto';
  const menuIds = [];

  function saveSettings() {
    try { GM_setValue(SETTINGS_KEY, settings); } catch (e) { warn('保存设置失败', e); }
  }

  function engineLabel(engine) {
    return { auto: '自动（A→B）', ddddocr: 'ddddocr ONNX', tesseract: 'Tesseract.js' }[engine] || engine;
  }

  function onOff(v) { return v ? '开' : '关'; }

  function registerMenu(label, fn) {
    try {
      const id = GM_registerMenuCommand(label, fn);
      if (id !== undefined && id !== null) menuIds.push(id);
    } catch (e) { warn('注册菜单失败', e); }
  }

  function refreshMenus() {
    while (menuIds.length) {
      const id = menuIds.pop();
      try { if (typeof GM_unregisterMenuCommand === 'function') GM_unregisterMenuCommand(id); } catch (e) {}
    }
    registerMenu('识别引擎：' + engineLabel(settings.engine), () => {
      const order = ['auto', 'ddddocr', 'tesseract'];
      settings.engine = order[(order.indexOf(settings.engine) + 1) % order.length];
      saveSettings();
      refreshMenus();
      toast('识别引擎已切换为：' + engineLabel(settings.engine));
    });
    registerMenu('自动填入：' + onOff(settings.autoFill), () => {
      settings.autoFill = !settings.autoFill;
      saveSettings();
      refreshMenus();
      if (settings.autoFill) scan(false);
    });
    registerMenu('跨域图片读取：' + onOff(settings.crossOriginImages), () => {
      settings.crossOriginImages = !settings.crossOriginImages;
      saveSettings();
      refreshMenus();
      if (settings.crossOriginImages) {
        toast('已开启；请确认图片域名已加入脚本 @connect');
      }
    });
    registerMenu('自动提交：' + onOff(settings.autoSubmit), () => {
      settings.autoSubmit = !settings.autoSubmit;
      saveSettings();
      refreshMenus();
    });
    registerMenu('调试日志：' + onOff(settings.debug), () => {
      settings.debug = !settings.debug;
      saveSettings();
      refreshMenus();
    });
    registerMenu('立即识别并填入当前页面验证码', () => {
      scan(true);
      toast('开始识别…');
    });
    registerMenu('导入本地 ddddocr 模型文件…', () => {
      showImportDialog();
    });
    registerMenu('清除模型缓存并重置引擎', () => {
      clearModelCache().then(async () => {
        await resetEngines();
        toast('模型缓存已清除');
      });
    });
  }

  // ========================= 日志与提示 =========================
  function debug(...args) {
    if (settings.debug) console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  let toastEl = null;
  let toastTimer = null;

  function toast(msg) {
    try {
      if (!document.documentElement) return;
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.style.cssText = [
          'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
          'max-width:320px', 'padding:8px 12px', 'background:rgba(20,20,20,.88)',
          'color:#fff', 'font:12px/1.45 system-ui,-apple-system,sans-serif',
          'border-radius:6px', 'box-shadow:0 4px 16px rgba(0,0,0,.25)',
          'pointer-events:none', 'opacity:0', 'transition:opacity .25s',
        ].join(';');
        document.documentElement.appendChild(toastEl);
      }
      toastEl.textContent = '[验证码] ' + msg;
      toastEl.style.opacity = '1';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { if (toastEl) toastEl.style.opacity = '0'; }, 2400);
    } catch (e) {}
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ========================= 存储 / 缓存 =========================
  function cacheKeyFor(name) {
    try { return new URL('/' + name, location.href).href; } catch (e) { return null; }
  }

  async function cacheGet(name) {
    try {
      if (typeof caches === 'undefined') return null;
      const key = cacheKeyFor(name);
      if (!key) return null;
      const cache = await caches.open(CACHE_NAME);
      const res = await cache.match(key);
      if (!res) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      return null;
    }
  }

  async function cachePut(name, bytes) {
    try {
      if (typeof caches === 'undefined') return;
      const key = cacheKeyFor(name);
      if (!key) return;
      const cache = await caches.open(CACHE_NAME);
      await cache.put(key, new Response(bytes.slice().buffer, {
        headers: { 'Content-Type': 'application/octet-stream' },
      }));
    } catch (e) {
      debug('缓存模型失败', e);
    }
  }

  async function cacheDelete(name) {
    try {
      if (typeof caches === 'undefined') return;
      const key = cacheKeyFor(name);
      if (!key) return;
      const cache = await caches.open(CACHE_NAME);
      await cache.delete(key);
    } catch (e) {
      debug('删除缓存失败', e);
    }
  }

  async function clearModelCache() {
    try {
      if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME);
    } catch (e) { debug('清除缓存失败', e); }
  }

  // ========================= 网络 =========================
  function gmFetchArrayBuffer(url, timeoutMs, onProgress) {
    const timeout = timeoutMs || 90000;
    return new Promise((resolve, reject) => {
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          responseType: 'arraybuffer',
          timeout,
          onprogress: (res) => {
            if (typeof onProgress !== 'function') return;
            try {
              onProgress(Number(res.loaded) || 0, Number(res.total || res.totalSize) || 0);
            } catch (e) {}
          },
          onload: (res) => {
            if (res.status >= 200 && res.status < 300 && res.response) {
              resolve(new Uint8Array(res.response));
            } else {
              reject(new Error('HTTP ' + res.status));
            }
          },
          onerror: () => reject(new Error('网络错误')),
          ontimeout: () => reject(new Error('请求超时')),
          onabort: () => reject(new Error('请求已中止')),
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value >= 1048576) return (value / 1048576).toFixed(1) + 'MB';
    if (value >= 1024) return Math.round(value / 1024) + 'KB';
    return Math.round(value) + 'B';
  }

  async function sha256Hex(bytes) {
    if (typeof crypto === 'undefined' || !crypto.subtle) return null;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }

  // ========================= ZIP 读取（从 wheel 中解出 onnx） =========================
  async function extractFileFromZip(arrayBuffer, entryName) {
    const u8 = new Uint8Array(arrayBuffer);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

    let eocd = -1;
    const minPos = Math.max(0, u8.length - 22 - 65535);
    for (let i = u8.length - 22; i >= minPos; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP：未找到中央目录');

    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const decoder = new TextDecoder();

    for (let n = 0; n < count; n++) {
      if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('ZIP：中央目录损坏');
      const method = dv.getUint16(off + 10, true);
      const compSize = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = decoder.decode(u8.subarray(off + 46, off + 46 + nameLen));

      if (name === entryName) {
        if (dv.getUint32(localOff, true) !== 0x04034b50) throw new Error('ZIP：本地文件头损坏');
        const lNameLen = dv.getUint16(localOff + 26, true);
        const lExtraLen = dv.getUint16(localOff + 28, true);
        const dataStart = localOff + 30 + lNameLen + lExtraLen;
        const comp = u8.subarray(dataStart, dataStart + compSize);

        if (method === 0) return comp.slice();
        if (method === 8) {
          if (typeof DecompressionStream === 'undefined') {
            throw new Error('当前浏览器不支持 DecompressionStream，无法解压 wheel');
          }
          const stream = new Blob([comp]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
          return new Uint8Array(await new Response(stream).arrayBuffer());
        }
        throw new Error('ZIP：不支持的压缩方式 ' + method);
      }
      off += 46 + nameLen + extraLen + commentLen;
    }
    throw new Error('ZIP：未找到条目 ' + entryName);
  }

  // ========================= 引擎 A：ddddocr ONNX =========================
  const engineA = {
    session: null,
    initPromise: null,
    bytesPromise: null,
    bytes: null,
    bytesOrigin: null, // 'local' | 'remote' | 'download'
    variant: null, // 'logits' | 'index'（输出形态，首次推理后确定）
  };
  let engineGeneration = 0;

  function getOrt() {
    if (typeof ort !== 'undefined' && ort) return ort;
    return null;
  }

  function buildModelSources() {
    const sources = [];
    if (settings.ddddocrModelUrl) {
      sources.push({ kind: 'onnx', url: settings.ddddocrModelUrl });
    }
    return sources.concat(MODEL_SOURCES);
  }

  async function fetchModelSource(src, onProgress) {
    const bytes = await gmFetchArrayBuffer(src.url, 120000, onProgress);
    if (src.kind === 'wheel') {
      const hex = await sha256Hex(bytes);
      if (src.sha256 && !hex) {
        throw new Error('当前环境不支持 SHA-256 校验，已拒绝加载 wheel');
      }
      if (src.sha256 && hex !== src.sha256) {
        throw new Error('wheel 校验失败');
      }
      return extractFileFromZip(bytes.buffer, src.entry);
    }
    return bytes;
  }

  async function releaseDdddSession(session) {
    if (!session || typeof session.release !== 'function') return;
    try { await session.release(); } catch (e) { debug('释放 ddddocr 会话失败', e); }
  }

  async function createDdddSession(bytes) {
    const ORT = getOrt();
    if (!ORT) {
      throw new Error('onnxruntime-web 未加载（@require 可能被网络拦截，请检查脚本头部 CDN 地址）');
    }
    ORT.env.wasm.wasmPaths = settings.ortWasmPaths;
    ORT.env.wasm.numThreads = 1;
    ORT.env.wasm.proxy = false;
    return ORT.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
  }

  async function validateDdddSession(session) {
    if (!session || !session.inputNames || !session.inputNames.length || !session.outputNames || !session.outputNames.length) {
      throw new Error('ONNX 模型输入或输出无效');
    }
    const probe = document.createElement('canvas');
    probe.width = 96;
    probe.height = 64;
    const ctx = probe.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, probe.width, probe.height);
    const output = await inferDddd(session, preprocessForDddd(probe), '01');
    const dims = output && output.dims ? output.dims : [];
    if ((dims.length !== 2 && dims.length !== 3) || !output.data || !output.data.length) {
      throw new Error('ONNX 模型输出与 ddddocr 不兼容：' + JSON.stringify(dims));
    }
    decodeDddd(output);
  }

  async function loadModelBytes(generation) {
    if (generation !== engineGeneration) throw new Error('ddddocr 引擎已重置');
    if (engineA.bytes) return engineA.bytes;
    if (engineA.bytesPromise) return engineA.bytesPromise;

    const bytesPromise = (async () => {
      const local = await cacheGet(LOCAL_MODEL_CACHE_KEY);
      if (generation !== engineGeneration) throw new Error('ddddocr 引擎已重置');
      if (local && local.length > 100 * 1024) {
        debug('使用本地导入的模型（缓存）');
        engineA.bytes = local;
        engineA.bytesOrigin = 'local';
        return local;
      }
      const cached = await cacheGet(REMOTE_MODEL_CACHE_KEY);
      if (generation !== engineGeneration) throw new Error('ddddocr 引擎已重置');
      if (cached && cached.length > 100 * 1024) {
        debug('使用缓存的远程模型');
        engineA.bytes = cached;
        engineA.bytesOrigin = 'remote';
        return cached;
      }

      let lastErr = null;
      for (const src of buildModelSources()) {
        try {
          debug('尝试加载模型：' + src.url);
          toast('正在获取验证码模型（首次约 6.9MB）…');
          let startedAt = 0;
          let lastProgressAt = 0;
          let lastPercent = -1;
          const onProgress = (loaded, total) => {
            const now = Date.now();
            if (!startedAt) startedAt = now;
            const percent = total > 0 ? Math.min(100, Math.floor(loaded * 100 / total)) : -1;
            if (now - lastProgressAt < 500 && percent !== 100) return;
            if (percent === lastPercent && now - lastProgressAt < 1000) return;
            lastProgressAt = now;
            lastPercent = percent;
            const elapsed = Math.max((now - startedAt) / 1000, 0.1);
            const speed = formatBytes(loaded / elapsed) + '/s';
            const amount = total > 0
              ? formatBytes(loaded) + ' / ' + formatBytes(total)
              : formatBytes(loaded);
            const detail = percent >= 0 ? percent + '%（' + amount + '，' + speed + '）' : amount + '，' + speed;
            debug('模型下载进度：' + detail);
            toast('正在下载验证码模型 ' + detail);
          };
          const bytes = await fetchModelSource(src, onProgress);
          if (!bytes || bytes.length < 100 * 1024) throw new Error('模型文件过小');
          if (generation !== engineGeneration) throw new Error('ddddocr 引擎已重置');
          engineA.bytes = bytes;
          engineA.bytesOrigin = 'download';
          cachePut(REMOTE_MODEL_CACHE_KEY, bytes);
          debug('模型加载成功，' + (bytes.length / 1048576).toFixed(1) + 'MB');
          return bytes;
        } catch (e) {
          if (generation !== engineGeneration) throw e;
          lastErr = e;
          debug('模型来源失败：' + src.url + ' → ' + (e && e.message ? e.message : e));
          toast('模型下载线路失败，正在切换备用线路…');
        }
      }
      throw new Error('所有模型来源均失败' + (lastErr ? '：' + lastErr.message : '') + '（可尝试菜单“导入本地模型文件”）');
    })();
    engineA.bytesPromise = bytesPromise;

    try {
      return await bytesPromise;
    } finally {
      if (engineA.bytesPromise === bytesPromise) engineA.bytesPromise = null;
    }
  }

  async function getDdddSession() {
    if (engineA.session) return engineA.session;
    if (engineA.initPromise) {
      await engineA.initPromise;
      if (!engineA.session) throw new Error('ddddocr 引擎已重置');
      return engineA.session;
    }

    const generation = engineGeneration;
    const initPromise = (async () => {
      let lastErr = null;
      // 本地/远程缓存可能来自旧版本或被损坏；校验失败时清除并继续尝试下一来源。
      for (let attempt = 0; attempt < 3; attempt++) {
        if (generation !== engineGeneration) throw new Error('ddddocr 引擎已重置');
        const bytes = await loadModelBytes(generation);
        let candidate = null;
        try {
          candidate = await createDdddSession(bytes);
          if (generation !== engineGeneration) {
            await releaseDdddSession(candidate);
            candidate = null;
            throw new Error('ddddocr 引擎已重置');
          }
          await validateDdddSession(candidate);
          if (generation !== engineGeneration) {
            await releaseDdddSession(candidate);
            candidate = null;
            throw new Error('ddddocr 引擎已重置');
          }
          engineA.session = candidate;
          candidate = null;
          engineA.variant = null;
          debug('ddddocr 会话已就绪，输入：' + engineA.session.inputNames.join(','),
            '输出：' + engineA.session.outputNames.join(','));
          return;
        } catch (e) {
          await releaseDdddSession(candidate);
          candidate = null;
          lastErr = e;
          if (generation !== engineGeneration) throw e;
          const origin = engineA.bytesOrigin;
          if ((origin === 'local' || origin === 'remote') && attempt < 2) {
            debug('缓存的 ddddocr 模型校验失败，清除后重试：' + (e && e.message ? e.message : e));
            await cacheDelete(origin === 'local' ? LOCAL_MODEL_CACHE_KEY : REMOTE_MODEL_CACHE_KEY);
            engineA.bytes = null;
            engineA.bytesOrigin = null;
            continue;
          }
          throw e;
        }
      }
      throw lastErr || new Error('ddddocr 模型初始化失败');
    })();
    engineA.initPromise = initPromise;

    try {
      await initPromise;
    } finally {
      if (engineA.initPromise === initPromise) engineA.initPromise = null;
    }
    if (!engineA.session) throw new Error('ddddocr 引擎已重置');
    return engineA.session;
  }

  async function resetEngines() {
    engineGeneration++;
    const oldSession = engineA.session;
    engineA.session = null;
    engineA.initPromise = null;
    engineA.bytesPromise = null;
    engineA.variant = null;
    engineA.bytes = null;
    engineA.bytesOrigin = null;
    if (tessWorker) {
      try { await tessWorker.terminate(); } catch (e) {}
      tessWorker = null;
    }
    tessWorkerPromise = null;
    await releaseDdddSession(oldSession);
  }

  // 与 ddddocr 一致：等比缩放到高 64，灰度，像素值归一化到 [0,1] 或 [-1,1]
  function preprocessForDddd(sourceCanvas) {
    const sw = sourceCanvas.width;
    const sh = sourceCanvas.height;
    if (!sw || !sh) throw new Error('验证码图片尺寸为 0');
    const W = Math.max(1, Math.floor(sw * 64 / sh));

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = 64;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sourceCanvas, 0, 0, W, 64);

    const data = ctx.getImageData(0, 0, W, 64).data;
    const luma = new Float32Array(W * 64);
    for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
      // PIL convert('L')：L = 0.299R + 0.587G + 0.114B（与 alpha 无关）
      luma[i] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255;
    }
    return { luma, width: W };
  }

  async function inferDddd(session, prep, norm) {
    const ORT = getOrt();
    const input = new Float32Array(prep.luma.length);
    for (let i = 0; i < input.length; i++) {
      input[i] = norm === 'pm1' ? (prep.luma[i] - 0.5) / 0.5 : prep.luma[i];
    }
    const tensor = new ORT.Tensor('float32', input, [1, 1, 64, prep.width]);
    const feeds = {};
    feeds[session.inputNames[0]] = tensor;
    const results = await session.run(feeds);
    return results[session.outputNames[0]];
  }

  function ctcDecode(indices) {
    const out = [];
    let prev = null;
    for (const raw of indices) {
      const idx = Number(raw);
      if (idx !== prev && idx !== 0) {
        if (idx >= 0 && idx < CHARSET.length) out.push(CHARSET[idx]);
      }
      prev = idx;
    }
    return out.join('');
  }

  function decodeDddd(output) {
    const dims = output.dims || [];
    const data = output.data;

    // 输出直接是字符索引（如 ddddocr 1.0.x 模型）：形状 [1, T] 或 [T, 1]
    if (dims.length === 2) {
      return ctcDecode(Array.from(data, Number));
    }

    // 输出是 logits（如 ddddocr 1.6.x common_old.onnx）：形状 [T, 1, C]
    const C = CHARSET.length;
    if (dims.length !== 3) throw new Error('模型输出维度不支持：' + JSON.stringify(dims));

    let classAxis = dims.lastIndexOf(C);
    if (classAxis < 0) {
      // 字符集长度与类别数不完全一致时，退化为最后一维
      classAxis = dims.length - 1;
    }
    const classCount = dims[classAxis];
    let timeAxis = -1;
    for (let i = 0; i < dims.length; i++) {
      if (i !== classAxis && dims[i] !== 1) { timeAxis = i; break; }
    }
    if (timeAxis < 0) throw new Error('无法确定模型序列维度：' + JSON.stringify(dims));

    const strides = new Array(dims.length);
    let stride = 1;
    for (let i = dims.length - 1; i >= 0; i--) {
      strides[i] = stride;
      stride *= dims[i];
    }
    const T = dims[timeAxis];
    const timeStride = strides[timeAxis];
    const classStride = strides[classAxis];

    const indices = new Array(T);
    for (let t = 0; t < T; t++) {
      const base = t * timeStride;
      let best = 0;
      let bestVal = -Infinity;
      for (let c = 0; c < classCount; c++) {
        const v = data[base + c * classStride];
        if (v > bestVal) { bestVal = v; best = c; }
      }
      indices[t] = best;
    }
    return ctcDecode(indices);
  }

  async function recognizeWithDddd(canvas) {
    const session = await getDdddSession();
    const prep = preprocessForDddd(canvas);

    let norm = engineA.variant === 'index' ? 'pm1' : '01';
    let output = await inferDddd(session, prep, norm);
    let dims = output.dims || [];

    // 索引输出说明当前模型是 ddddocr 1.0.x 版本，其归一化应为 [-1,1]，需要重跑一次
    if (dims.length === 2 && engineA.variant !== 'index') {
      output = await inferDddd(session, prep, 'pm1');
      dims = output.dims || [];
    } else if (dims.length === 3 && engineA.variant === 'index') {
      output = await inferDddd(session, prep, '01');
      dims = output.dims || [];
    }

    engineA.variant = dims.length === 2 ? 'index' : 'logits';
    return decodeDddd(output);
  }

  // ========================= 引擎 B：Tesseract.js =========================
  let tessWorker = null;
  let tessWorkerPromise = null;

  function getTesseract() {
    if (typeof Tesseract !== 'undefined' && Tesseract) return Tesseract;
    return null;
  }

  async function getTessWorker() {
    if (tessWorker) return tessWorker;
    if (tessWorkerPromise) return tessWorkerPromise;

    const generation = engineGeneration;
    const workerPromise = (async () => {
      const T = getTesseract();
      if (!T) {
        throw new Error('Tesseract.js 未加载（@require 可能被网络拦截）');
      }
      let worker = null;
      try {
        worker = await T.createWorker(settings.tesseractLang, 1, {
          workerPath: settings.tesseractWorkerPath,
          corePath: settings.tesseractCorePath,
          langPath: settings.tesseractLangPath,
          logger: (m) => {
            if (settings.debug && m && m.status) {
              debug('[tesseract] ' + m.status + ' ' + Math.round((m.progress || 0) * 100) + '%');
            }
          },
        });
        const params = { tessedit_pageseg_mode: '7' }; // 单行文本
        if (settings.tesseractWhitelist) {
          params.tessedit_char_whitelist = settings.tesseractWhitelist;
        }
        await worker.setParameters(params);
        if (generation !== engineGeneration) throw new Error('Tesseract 引擎已重置');
        tessWorker = worker;
        worker = null;
        return tessWorker;
      } catch (e) {
        if (worker) {
          try { await worker.terminate(); } catch (terminateErr) {}
        }
        throw e;
      }
    })();
    tessWorkerPromise = workerPromise;

    try {
      return await workerPromise;
    } finally {
      if (tessWorkerPromise === workerPromise) tessWorkerPromise = null;
    }
  }

  function otsuThreshold(gray) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    const total = gray.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0;
    let wB = 0;
    let maxVar = 0;
    let threshold = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > maxVar) {
        maxVar = between;
        threshold = t;
      }
    }
    return threshold;
  }

  // 放大 → 灰度 → Otsu 二值化 → 保证白底黑字 → 加白边
  function preprocessForTesseract(sourceCanvas) {
    const scale = Math.min(5, Math.max(2, 96 / (sourceCanvas.height || 1)));
    const w = Math.max(1, Math.round(sourceCanvas.width * scale));
    const h = Math.max(1, Math.round(sourceCanvas.height * scale));

    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const ctx = tmp.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sourceCanvas, 0, 0, w, h);

    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    const gray = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = Math.round(0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]);
    }

    const threshold = otsuThreshold(gray);
    let darkCount = 0;
    for (let i = 0; i < gray.length; i++) if (gray[i] < threshold) darkCount++;
    const invert = darkCount > gray.length * 0.5; // 文字应占少数；否则说明是深底浅字

    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      let v = gray[i] < threshold ? 0 : 255;
      if (invert) v = 255 - v;
      data[p] = data[p + 1] = data[p + 2] = v;
      data[p + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);

    const pad = 12;
    const out = document.createElement('canvas');
    out.width = w + pad * 2;
    out.height = h + pad * 2;
    const octx = out.getContext('2d');
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(tmp, pad, pad);
    return out;
  }

  async function recognizeWithTesseract(canvas) {
    const worker = await getTessWorker();
    const prepared = preprocessForTesseract(canvas);
    const result = await worker.recognize(prepared);
    return (result && result.data && result.data.text) || '';
  }

  // ========================= 统一识别入口 =========================
  function sanitizeText(text) {
    return String(text || '').replace(/\s+/g, '');
  }

  async function recognizeCanvas(canvas) {
    const engine = settings.engine;
    const startedAt = Date.now();
    let text = '';
    let lastErr = null;

    if (engine === 'ddddocr' || engine === 'auto') {
      try {
        text = sanitizeText(await recognizeWithDddd(canvas));
        debug('ddddocr 结果：' + JSON.stringify(text) + '（' + (Date.now() - startedAt) + 'ms）');
      } catch (e) {
        lastErr = e;
        debug('ddddocr 识别失败：' + (e && e.message ? e.message : e));
        if (engine === 'ddddocr') throw e;
      }
    }

    if ((engine === 'tesseract' || engine === 'auto') && !text) {
      try {
        text = sanitizeText(await recognizeWithTesseract(canvas));
        debug('tesseract 结果：' + JSON.stringify(text) + '（' + (Date.now() - startedAt) + 'ms）');
      } catch (e) {
        lastErr = lastErr || e;
        debug('tesseract 识别失败：' + (e && e.message ? e.message : e));
        if (engine === 'tesseract') throw e;
      }
    }

    text = sanitizeText(text);
    if (!text && lastErr) {
      throw lastErr;
    }
    return text;
  }

  // ========================= 图片获取 =========================
  function waitForImage(img, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (img.complete && img.naturalWidth > 0) return resolve();
      let done = false;
      const finish = (fn, arg) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
        fn(arg);
      };
      const onLoad = () => finish(resolve);
      const onError = () => finish(reject, new Error('验证码图片加载失败'));
      const timer = setTimeout(() => finish(reject, new Error('验证码图片加载超时')), timeoutMs || 5000);
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);
    });
  }

  async function elementToCanvas(el) {
    if (el.tagName === 'CANVAS') {
      const w = el.width || el.clientWidth;
      const h = el.height || el.clientHeight;
      if (!w || !h) throw new Error('canvas 尺寸为 0');
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d', { willReadFrequently: true }).drawImage(el, 0, 0);
      return c;
    }

    if (el.tagName !== 'IMG') throw new Error('不支持的验证码元素：' + el.tagName);

    await waitForImage(el);
    const w = el.naturalWidth || el.width;
    const h = el.naturalHeight || el.height;
    if (!w || !h) throw new Error('图片尺寸为 0');

    // 优先直接绘制：同源图片不产生重复请求，避免一次性验证码 URL 被“刷新”
    try {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(el, 0, 0, w, h);
      ctx.getImageData(0, 0, 1, 1); // 跨域画布会抛 SecurityError
      return c;
    } catch (e) {
      if (!settings.crossOriginImages) {
        throw new Error('图片跨域；为避免重复请求一次性验证码，跨域读取默认关闭');
      }
      debug('图片跨域，改用 GM_xmlhttpRequest 获取：' + (el.currentSrc || el.src));
    }

    const url = el.currentSrc || el.src;
    if (!url || url.startsWith('data:')) throw new Error('无法获取图片数据');
    const bytes = await gmFetchArrayBuffer(url, 20000);
    let bitmap;
    try {
      bitmap = await createImageBitmap(new Blob([bytes]));
    } catch (e) {
      throw new Error('验证码图片解码失败');
    }
    const c = document.createElement('canvas');
    c.width = bitmap.width;
    c.height = bitmap.height;
    c.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0);
    if (bitmap.close) bitmap.close();
    return c;
  }

  // ========================= 页面元素探测 =========================
  // 只接受较明确的验证码提示词；单独的 verify/validate 会命中大量普通表单。
  const HINT_RE = /captcha|check[\s_-]*img|verif(?:y|ication)[\s_-]*(?:code|image|captcha|human)|vcode|valicode|checkcode|authcode|validate[\s_-]*code|security[\s_-]*code|yzm|yzmc|验证码|校验码|图形码|人机验证/i;
  // 图形式验证码的输入框通常比“验证码/短信验证码”更具体，配对时优先选择这类字段。
  const GRAPHIC_HINT_RE = /图形码|图形验证码|图片验证码|图像验证码|验证码图片|captcha[\s_-]*(?:image|img|code)|image[\s_-]*captcha|vcode|valicode|checkcode/i;

  function attrText(el) {
    return [
      el.id,
      el.getAttribute('class'),
      el.getAttribute('name'),
      el.getAttribute('placeholder'),
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('alt'),
      el.getAttribute('src'),
    ].filter(Boolean).join(' ');
  }

  function normalizeText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function labelText(el) {
    const parts = [];
    try {
      if (el.labels) {
        Array.from(el.labels).forEach((label) => parts.push(normalizeText(label.textContent)));
      }
    } catch (e) {}

    const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledBy) {
      labelledBy.split(/\s+/).forEach((id) => {
        const label = id && document.getElementById(id);
        if (label) parts.push(normalizeText(label.textContent));
      });
    }

    // 兼容常见的 div/span 自定义标签：只取最近一段较短的行文本，避免把整张表单都算进来。
    let node = el.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const raw = node.textContent || '';
      if (raw.length > 1000) continue;
      const text = normalizeText(raw);
      if (text && text.length <= 160) {
        parts.push(text);
        break;
      }
    }
    return parts.filter(Boolean).join(' ');
  }

  function hintText(el) {
    return [attrText(el), labelText(el)].filter(Boolean).join(' ');
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    if (el.hidden || el.closest('[hidden], [aria-hidden="true"]')) return false;
    let node = el.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      if (getComputedStyle(node).opacity === '0') return false;
    }
    return true;
  }

  function isTextInput(el) {
    if (el.tagName !== 'INPUT') return false;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return ['text', 'search', 'tel', 'number', ''].includes(type) && !el.disabled && !el.readOnly;
  }

  function isPlausibleCaptcha(el) {
    const rect = el.getBoundingClientRect();
    let w = rect.width;
    let h = rect.height;
    if (el.tagName === 'IMG') {
      w = el.naturalWidth || w;
      h = el.naturalHeight || h;
    } else if (el.tagName === 'CANVAS') {
      w = el.width || w;
      h = el.height || h;
    }
    if (w < 30 || h < 12 || w > 600 || h > 220) return false;
    const ratio = w / h;
    return ratio >= 1.2 && ratio <= 10;
  }

  function centerDistance(a, b) {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const ax = ra.left + ra.width / 2;
    const ay = ra.top + ra.height / 2;
    const bx = rb.left + rb.width / 2;
    const by = rb.top + rb.height / 2;
    return Math.hypot(ax - bx, ay - by);
  }

  function isSameRow(a, b) {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const overlap = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
    const minHeight = Math.min(ra.height, rb.height);
    if (overlap >= Math.max(6, minHeight * 0.45)) return true;

    const ac = ra.top + ra.height / 2;
    const bc = rb.top + rb.height / 2;
    return Math.abs(ac - bc) <= Math.max(10, minHeight * 0.6);
  }

  function countInputsBetween(a, b, allInputs) {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const ac = ra.top + ra.height / 2;
    const bc = rb.top + rb.height / 2;
    if (isSameRow(a, b)) return 0;

    const low = Math.min(ac, bc);
    const high = Math.max(ac, bc);
    let count = 0;
    for (const input of allInputs) {
      if (input === a) continue;
      const rect = input.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      if (center > low + 4 && center < high - 4) {
        count++;
      }
    }
    return count;
  }

  function scorePair(input, image, allInputs, inputHinted, inputText) {
    const distance = centerDistance(input, image);
    if (!Number.isFinite(distance) || distance > 900) return Infinity;

    let score = distance;
    if (isSameRow(input, image)) score -= 20000;
    // 如果两者之间还夹着其他输入行，很可能是在向上“借用”另一个验证码图片。
    score += countInputsBetween(input, image, allInputs) * 5000;
    if (GRAPHIC_HINT_RE.test(inputText)) score -= 750;
    if (!inputHinted) score += 1200;
    return score;
  }

  function findPairs() {
    const pairs = [];
    const usedInputs = new Set();
    const usedImages = new Set();

    const allInputs = Array.from(document.querySelectorAll('input')).filter(isTextInput).filter(isVisible);
    const allImages = Array.from(document.querySelectorAll('img, canvas')).filter(isVisible).filter(isPlausibleCaptcha);
    const inputHints = new Map(allInputs.map(el => [el, hintText(el)]));
    const imageHints = new Map(allImages.map(el => [el, hintText(el)]));
    const hintedInputs = allInputs.filter(el => HINT_RE.test(inputHints.get(el)));
    const hintedImages = allImages.filter(el => HINT_RE.test(imageHints.get(el)));

    // 不要按输入框 DOM 顺序“谁先抢到算谁的”。统一给所有候选打分，
    // 同一行优先，其次看距离与“图形码”等更具体的标签；跨过其他输入行的候选会被重罚。
    const candidates = [];
    for (const image of hintedImages) {
      if (usedImages.has(image)) continue;
      let pool = hintedInputs.filter(input => !usedInputs.has(input));
      if (!pool.length) pool = allInputs.filter(input => !usedInputs.has(input));
      for (const input of pool) {
        const score = scorePair(input, image, allInputs, hintedInputs.includes(input), inputHints.get(input));
        if (Number.isFinite(score)) candidates.push({ input, image, score });
      }
    }
    candidates.sort((a, b) => a.score - b.score);

    for (const candidate of candidates) {
      if (usedInputs.has(candidate.input) || usedImages.has(candidate.image)) continue;
      pairs.push({ input: candidate.input, image: candidate.image });
      usedInputs.add(candidate.input);
      usedImages.add(candidate.image);
    }

    return pairs;
  }

  // ========================= 填入与提交 =========================
  function captureCursorState() {
    const active = document.activeElement;
    const state = { active, start: null, end: null, direction: null, range: null };
    if (!active) return state;

    try {
      if (typeof active.selectionStart === 'number' && typeof active.selectionEnd === 'number') {
        state.start = active.selectionStart;
        state.end = active.selectionEnd;
        state.direction = active.selectionDirection || null;
      }
    } catch (e) {}

    try {
      if (active.isContentEditable) {
        const selection = window.getSelection();
        if (selection && selection.rangeCount) {
          const range = selection.getRangeAt(0);
          if (active.contains(range.commonAncestorContainer)) state.range = range.cloneRange();
        }
      }
    } catch (e) {}
    return state;
  }

  function restoreCursorState(state, filledInput, text) {
    if (!state || !state.active) return;
    const active = state.active;
    try {
      if (active === filledInput) {
        if (typeof filledInput.setSelectionRange === 'function') {
          filledInput.setSelectionRange(text.length, text.length);
        }
        return;
      }
      if (active === document.body || active === document.documentElement) {
        if (typeof filledInput.blur === 'function') filledInput.blur();
        return;
      }
      if (!active.isConnected || typeof active.focus !== 'function') return;

      try { active.focus({ preventScroll: true }); } catch (focusErr) { active.focus(); }
      if (typeof state.start === 'number' && typeof active.setSelectionRange === 'function') {
        const max = typeof active.value === 'string' ? active.value.length : state.start;
        const start = Math.min(state.start, max);
        const end = Math.min(typeof state.end === 'number' ? state.end : state.start, max);
        if (state.direction) active.setSelectionRange(start, end, state.direction);
        else active.setSelectionRange(start, end);
      } else if (state.range) {
        const selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(state.range);
        }
      }
    } catch (e) {
      debug('恢复光标位置失败：' + (e && e.message ? e.message : e));
    }
  }

  function fillInput(input, text) {
    const cursorState = captureCursorState();
    try {
      try { input.focus({ preventScroll: true }); } catch (e) {}
      const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) {
        desc.set.call(input, text);
      } else {
        input.value = text;
      }
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } finally {
      restoreCursorState(cursorState, input, text);
    }
    debug('已填入：' + JSON.stringify(text));
  }

  function scheduleSubmit(pair, expectedText, expectedSig) {
    setTimeout(() => {
      try {
        const input = pair.input;
        const image = pair.image;
        if (!input || !input.isConnected || input.value !== expectedText) {
          debug('自动提交已取消：输入框已变化');
          return;
        }
        if (!image || !image.isConnected || imageSignature(image) !== expectedSig) {
          debug('自动提交已取消：验证码已刷新');
          return;
        }
        const form = input.form;
        if (form) {
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        }
      } catch (e) {
        debug('自动提交失败：' + (e && e.message ? e.message : e));
      }
    }, 450);
  }

  // ========================= 识别流程 =========================
  const pairState = new WeakMap(); // input -> { image, sig, done, lastText, lastFilledText }
  const processingInputs = new Set();
  const pendingForcePairs = new Map();

  function imageSignature(image) {
    if (!image) return '';
    if (image.tagName === 'IMG') {
      return (image.currentSrc || '') + '|' + (image.src || '');
    }
    return 'canvas:' + image.width + 'x' + image.height;
  }

  async function processPair(pair, opts) {
    const options = opts || {};
    const input = pair.input;
    const image = pair.image;
    if (!input || !image || !input.isConnected || !image.isConnected) return;
    if (processingInputs.has(input)) {
      if (options.force) pendingForcePairs.set(input, pair);
      return;
    }
    if (!settings.autoFill && !options.force) return;

    const sig = imageSignature(image);

    let rec = pairState.get(input);
    if (!options.force && rec && rec.image === image && rec.sig === sig && rec.done) return;

    processingInputs.add(input);
    let reprocess = false;
    try {
      const canvas = await elementToCanvas(image);
      const text = await recognizeCanvas(canvas);

      if (!input.isConnected || !image.isConnected) return;
      const finalSig = imageSignature(image);
      if (finalSig !== sig) {
        debug('识别期间验证码已刷新，丢弃旧识别结果');
        rec = pairState.get(input) || {};
        rec.image = image;
        rec.sig = finalSig;
        rec.done = false;
        pairState.set(input, rec);
        reprocess = true;
        return;
      }

      rec = pairState.get(input) || {};
      rec.image = image;
      rec.sig = finalSig;
      rec.done = true;
      rec.lastText = text;
      pairState.set(input, rec);

      if (!text) {
        debug('识别结果为空，跳过填入');
        return;
      }

      const shouldFill = settings.autoFill || options.force;
      if (shouldFill) {
        const currentValue = input.value;
        const untouched = !rec.lastFilledText || currentValue === '' || currentValue === rec.lastFilledText;
        if (untouched && input.isConnected && image.isConnected && imageSignature(image) === finalSig) {
          fillInput(input, text);
          rec.lastFilledText = text;
          pairState.set(input, rec);
          if (settings.autoSubmit) scheduleSubmit(pair, text, finalSig);
        } else {
          debug('输入框内容已被手动修改，跳过回填');
        }
      }
    } catch (e) {
      debug('处理验证码失败：' + (e && e.message ? e.message : e));
      if (settings.debug) toast('识别失败：' + ((e && e.message) || e));
    } finally {
      processingInputs.delete(input);
      if (reprocess) {
        setTimeout(() => {
          processPair(pair, options).catch((e) => debug('重新识别失败：' + (e && e.message ? e.message : e)));
        }, 0);
      } else {
        const pending = pendingForcePairs.get(input);
        if (pending) {
          pendingForcePairs.delete(input);
          setTimeout(() => {
            processPair(pending, { force: true }).catch((e) => debug('重新识别失败：' + (e && e.message ? e.message : e)));
          }, 0);
        }
      }
    }
  }

  function scan(force) {
    const pairs = findPairs();
    if (force) debug('发现 ' + pairs.length + ' 组验证码');
    for (const pair of pairs) {
      processPair(pair, { force: !!force }).catch((e) => {
        debug('处理异常：' + (e && e.message ? e.message : e));
      });
    }
  }

  let scanTimer = null;
  function scheduleScan() {
    if (!settings.autoFill) return;
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan(false);
    }, 500);
  }

  function startObserver() {
    if (!document.documentElement) return;

    // 验证码图片可能在首次扫描时尚未加载完成，load 事件不会冒泡，需用捕获阶段监听。
    document.addEventListener('load', (event) => {
      const target = event && event.target;
      if (target && target.tagName === 'IMG') scheduleScan();
    }, true);
    window.addEventListener('load', scheduleScan, { once: true });

    // SPA 或懒加载页面可能没有触发 DOM 变更；启动后再做几次温和重试。
    [500, 1500, 3500].forEach((delay) => {
      setTimeout(() => {
        if (settings.autoFill) scan(false);
      }, delay);
    });

    if (typeof MutationObserver === 'undefined') return;
    const isRelevantNode = (node) => {
      if (!node || node.nodeType !== 1) return false;
      if (node.matches('input, img, canvas, form')) return true;
      return !!(node.querySelector && node.querySelector('input, img, canvas'));
    };
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'src') {
          scheduleScan();
          return;
        }
        if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
          for (const node of m.addedNodes) {
            if (isRelevantNode(node)) { scheduleScan(); return; }
          }
          for (const node of m.removedNodes) {
            if (isRelevantNode(node)) { scheduleScan(); return; }
          }
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });
  }

  // ========================= 本地模型导入 =========================
  function showImportDialog() {
    try {
      const overlay = document.createElement('div');
      overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483647',
        'background:rgba(0,0,0,.45)', 'display:flex',
        'align-items:center', 'justify-content:center',
      ].join(';');

      const box = document.createElement('div');
      box.style.cssText = [
        'background:#fff', 'color:#222', 'border-radius:8px',
        'padding:18px 20px', 'max-width:440px', 'width:calc(100% - 40px)',
        'font:13px/1.6 system-ui,-apple-system,sans-serif',
        'box-shadow:0 12px 40px rgba(0,0,0,.3)',
      ].join(';');
      box.textContent = '选择 ddddocr 的 ONNX 模型文件（common.onnx / common_old.onnx，约 13MB）。';

      const file = document.createElement('input');
      file.type = 'file';
      file.accept = '.onnx,application/octet-stream';
      file.style.cssText = 'display:block;margin:12px 0;';

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';

      const cancel = document.createElement('button');
      cancel.textContent = '取消';
      cancel.style.cssText = 'padding:6px 14px;cursor:pointer;';

      const ok = document.createElement('button');
      ok.textContent = '导入';
      ok.style.cssText = 'padding:6px 14px;cursor:pointer;background:#2563eb;color:#fff;border:none;border-radius:4px;';

      const close = () => { try { overlay.remove(); } catch (e) {} };
      cancel.addEventListener('click', close);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

      ok.addEventListener('click', async () => {
        if (ok.disabled) return;
        const f = file.files && file.files[0];
        if (!f) { toast('请先选择模型文件'); return; }
        ok.disabled = true;
        let candidate = null;
        try {
          const bytes = new Uint8Array(await f.arrayBuffer());
          if (bytes.length < 1024 * 1024) throw new Error('文件太小，可能不是 ONNX 模型');
          toast('正在校验模型…');
          candidate = await createDdddSession(bytes);
          await validateDdddSession(candidate);

          engineGeneration++;
          const oldSession = engineA.session;
          engineA.session = candidate;
          candidate = null;
          engineA.bytes = bytes;
          engineA.bytesOrigin = 'local';
          engineA.bytesPromise = null;
          engineA.initPromise = null;
          engineA.variant = null;
          await cachePut(LOCAL_MODEL_CACHE_KEY, bytes);
          await releaseDdddSession(oldSession);
          close();
          toast('模型已导入（' + (bytes.length / 1048576).toFixed(1) + 'MB）');
          scan(true);
        } catch (e) {
          await releaseDdddSession(candidate);
          ok.disabled = false;
          toast('导入失败：' + ((e && e.message) || e));
        }
      });

      actions.appendChild(cancel);
      actions.appendChild(ok);
      box.appendChild(file);
      box.appendChild(actions);
      overlay.appendChild(box);
      document.documentElement.appendChild(overlay);
    } catch (e) {
      warn('无法打开导入对话框', e);
    }
  }

  // ========================= 启动 =========================
  function init() {
    refreshMenus();
    startObserver();
    if (settings.autoFill) scan(false);
    debug('已启动，引擎：' + engineLabel(settings.engine));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
