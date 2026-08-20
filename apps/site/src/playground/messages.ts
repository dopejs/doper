/**
 * User-visible strings for the playground shell and its demos.
 *
 * The sample content drawn inside the canvas (order rows, field values) stays
 * as authored: it is demo data, not site chrome. Everything the page renders
 * around it — demo titles, descriptions, HUD labels and controls — follows the
 * active site locale.
 */
export interface PlaygroundMessages {
  readonly loading: string;
  readonly frames: string;
  readonly commands: string;
  readonly displayList: string;
  readonly sceneNodes: string;
  readonly layoutVisited: string;
  readonly dirtyPaint: string;
  readonly placeholders: string;
  readonly skippedInstructions: string;
  readonly scrollTitle: string;
  readonly scrollDescription: string;
  readonly listItems: string;
  readonly nodesPerRow: string;
  readonly selectedRows: string;
  readonly lastAction: string;
  readonly viewOrder: string;
  readonly jumpToRow: (row: string) => string;
  readonly editingTitle: string;
  readonly editingDescription: string;
  readonly editTransactions: string;
  readonly shellValue: string;
  readonly inputBridge: string;
  readonly editingHint: string;
  readonly eventsTitle: string;
  readonly eventsDescription: string;
  readonly propagationLog: string;
  readonly semanticsTitle: string;
  readonly semanticsDescription: string;
  readonly readSemantics: string;
  readonly transportTitle: string;
  readonly transportDescription: string;
  readonly crossOriginIsolated: string;
  readonly transportMode: string;
  readonly uiClockLabel: string;
  readonly uiClockHint: string;
  readonly coreClockLabel: string;
  readonly coreClockHint: string;
  readonly actualStall: string;
  readonly workerFramesDuringStall: string;
  readonly selfDrivenFramesDuringStall: string;
  readonly maximumWorkerFrameGap: string;
  readonly blockMainThread: string;
  readonly stallOnMainThread: string;
  readonly stallOnWorker: string;
}

const MESSAGES: Record<string, PlaygroundMessages> = {
  "zh-Hans": {
    loading: "正在加载引擎核心（约 1MB WASM）…",
    frames: "帧数",
    commands: "命令数",
    displayList: "DisplayList",
    sceneNodes: "Scene 节点",
    layoutVisited: "布局访问",
    dirtyPaint: "脏绘制",
    placeholders: "占位",
    skippedInstructions: "跳过的指令",
    scrollTitle: "百万行原生虚拟滚动",
    scrollDescription:
      "一百万行由 Core 拥有的虚拟列表。滚动稳态完全在 Core 内闭环、不回调 Shell，Shell 只按 Core 规划的预热窗口物化可见区间。用滚轮或拖拽试试，右侧是实时帧指标。",
    listItems: "列表项",
    nodesPerRow: "每行节点数",
    selectedRows: "已选中",
    lastAction: "最近操作",
    viewOrder: "查看",
    jumpToRow: (row) => `跳到第 ${row} 行`,
    editingTitle: "canvas 原生编辑与 IME",
    editingDescription:
      "业务不创建任何 HTML 输入控件。引擎在 canvas 上绑定 EditContext（不支持时降级到宿主统一托管的隐藏 textarea 代理），caret、选区、IME 候选窗定位、剪贴板与撤销重做都由 Core 负责。",
    editTransactions: "编辑事务",
    shellValue: "Shell 值",
    inputBridge: "输入桥",
    editingHint: "先点一下输入框获取焦点，再输入或用输入法。",
    eventsTitle: "命中测试与三阶段事件",
    eventsDescription:
      "命中测试在 Core 内用增量 BVH 完成，事件按 capture → target → bubble 三阶段传播，与 DOM 对齐。点击嵌套区域查看实时传播日志。",
    propagationLog: "传播日志（新→旧）",
    semanticsTitle: "语义树与无障碍影子 DOM",
    semanticsDescription:
      "Core 导出语义树，宿主把它镜像成 canvas 旁的 DOM 影子树。屏幕阅读器可用，E2E 能按 role/label 选中元素，密码值永远不进入语义树。",
    readSemantics: "读取语义树 + 聚焦“收件人”",
    transportTitle: "双时钟与降级链",
    transportDescription:
      "UI 时钟与渲染时钟相互独立。能力探测在 SharedArrayBuffer、postMessage 与主线程 Canvas2D 之间选择传输路径；阻塞主线程试试，Worker 路径下画面仍然连续。",
    crossOriginIsolated: "跨源隔离",
    transportMode: "传输模式",
    uiClockLabel: "UI / Shell 时钟",
    uiClockHint: "主线程 rAF 驱动；阻塞时红色游标冻结",
    coreClockLabel: "Core / Worker 时钟",
    coreClockHint: "百万行 Core 原生滚动；与按钮无关，始终运行",
    actualStall: "实际阻塞",
    workerFramesDuringStall: "阻塞期间 Worker 帧",
    selfDrivenFramesDuringStall: "其中 Worker 自驱帧",
    maximumWorkerFrameGap: "Worker 最大帧间隔",
    stallOnMainThread: "当前是主线程路径，阻塞期间动画会停顿——这就是需要 Worker 的原因。",
    stallOnWorker: "当前是 Worker 路径，阻塞期间渲染时钟仍在 Worker 内推进。",
    blockMainThread: "仅阻塞主线程 1 秒",
  },
  "zh-Hant": {
    loading: "正在載入引擎核心（約 1MB WASM）…",
    frames: "幀數",
    commands: "指令數",
    displayList: "DisplayList",
    sceneNodes: "Scene 節點",
    layoutVisited: "版面訪問",
    dirtyPaint: "髒繪製",
    placeholders: "佔位",
    skippedInstructions: "跳過的指令",
    scrollTitle: "百萬列原生虛擬捲動",
    scrollDescription:
      "一百萬列由 Core 擁有的虛擬列表。捲動穩態完全在 Core 內閉環、不回呼 Shell，Shell 只按 Core 規劃的預熱視窗具現化可見區間。用滾輪或拖曳試試，右側是即時幀指標。",
    listItems: "列表項",
    nodesPerRow: "每列節點數",
    selectedRows: "已選取",
    lastAction: "最近操作",
    viewOrder: "查看",
    jumpToRow: (row) => `跳到第 ${row} 列`,
    editingTitle: "canvas 原生編輯與 IME",
    editingDescription:
      "業務不建立任何 HTML 輸入控制項。引擎在 canvas 上綁定 EditContext（不支援時降級到宿主統一託管的隱藏 textarea 代理），caret、選取範圍、IME 候選視窗定位、剪貼簿與復原重做都由 Core 負責。",
    editTransactions: "編輯交易",
    shellValue: "Shell 值",
    inputBridge: "輸入橋",
    editingHint: "先點一下輸入框取得焦點，再輸入或用輸入法。",
    eventsTitle: "命中測試與三階段事件",
    eventsDescription:
      "命中測試在 Core 內用增量 BVH 完成，事件按 capture → target → bubble 三階段傳播，與 DOM 對齊。點擊巢狀區域查看即時傳播記錄。",
    propagationLog: "傳播記錄（新→舊）",
    semanticsTitle: "語意樹與無障礙影子 DOM",
    semanticsDescription:
      "Core 匯出語意樹，宿主把它鏡像成 canvas 旁的 DOM 影子樹。螢幕閱讀器可用，E2E 能依 role/label 選取元素，密碼值永遠不進入語意樹。",
    readSemantics: "讀取語意樹 + 聚焦「收件人」",
    transportTitle: "雙時鐘與降級鏈",
    transportDescription:
      "UI 時鐘與繪製時鐘彼此獨立。能力偵測在 SharedArrayBuffer、postMessage 與主執行緒 Canvas2D 之間選擇傳輸路徑；阻塞主執行緒試試，Worker 路徑下畫面仍然連續。",
    crossOriginIsolated: "跨來源隔離",
    transportMode: "傳輸模式",
    uiClockLabel: "UI / Shell 時鐘",
    uiClockHint: "主執行緒 rAF 驅動；阻塞時紅色游標凍結",
    coreClockLabel: "Core / Worker 時鐘",
    coreClockHint: "百萬列 Core 原生捲動；與按鈕無關，持續運行",
    actualStall: "實際阻塞",
    workerFramesDuringStall: "阻塞期間 Worker 幀",
    selfDrivenFramesDuringStall: "其中 Worker 自驅幀",
    maximumWorkerFrameGap: "Worker 最大幀間隔",
    stallOnMainThread: "目前是主執行緒路徑，阻塞期間動畫會停頓——這就是需要 Worker 的原因。",
    stallOnWorker: "目前是 Worker 路徑，阻塞期間繪製時鐘仍在 Worker 內推進。",
    blockMainThread: "僅阻塞主執行緒 1 秒",
  },
  "ja": {
    loading: "エンジンコアを読み込み中（約 1MB の WASM）…",
    frames: "フレーム数",
    commands: "コマンド数",
    displayList: "DisplayList",
    sceneNodes: "Scene ノード",
    layoutVisited: "レイアウト走査",
    dirtyPaint: "ダーティ描画",
    placeholders: "プレースホルダー",
    skippedInstructions: "スキップした命令",
    scrollTitle: "100 万行のネイティブ仮想スクロール",
    scrollDescription:
      "100 万行の仮想リストを Core が所有します。スクロール中は Core 内で完結し Shell を呼び出しません。Shell は Core が計画したプリフェッチウィンドウの可視区間だけを実体化します。ホイールやドラッグで試してください。右側がリアルタイムのフレーム指標です。",
    listItems: "リスト項目",
    nodesPerRow: "行あたりノード数",
    selectedRows: "選択済み",
    lastAction: "最後の操作",
    viewOrder: "表示",
    jumpToRow: (row) => `${row} 行目へ移動`,
    editingTitle: "canvas ネイティブ編集と IME",
    editingDescription:
      "アプリケーションは HTML の入力コントロールを作りません。エンジンが canvas に EditContext を結び付け（使えない場合はホストが一元管理する隠し textarea にフォールバック）、キャレット、選択、IME 候補ウィンドウの位置、クリップボード、取り消し／やり直しはすべて Core が担当します。",
    editTransactions: "編集トランザクション",
    shellValue: "Shell の値",
    inputBridge: "入力ブリッジ",
    editingHint: "まず入力欄をクリックしてフォーカスし、それから入力または IME を使ってください。",
    eventsTitle: "ヒットテストと 3 フェーズイベント",
    eventsDescription:
      "ヒットテストは Core 内の差分 BVH で行い、イベントは capture → target → bubble の 3 フェーズで DOM と同じように伝播します。入れ子の領域をクリックすると伝播ログをリアルタイムに確認できます。",
    propagationLog: "伝播ログ（新しい順）",
    semanticsTitle: "セマンティクスツリーとアクセシビリティのシャドウ DOM",
    semanticsDescription:
      "Core がセマンティクスツリーを書き出し、ホストが canvas の隣の DOM シャドウツリーに反映します。スクリーンリーダーで読め、E2E は role/label で要素を選択でき、パスワードの値がツリーに入ることはありません。",
    readSemantics: "セマンティクスツリーを読む + 「宛先」にフォーカス",
    transportTitle: "デュアルクロックとフォールバックチェーン",
    transportDescription:
      "UI クロックとレンダリングクロックは独立しています。能力検出が SharedArrayBuffer、postMessage、メインスレッド Canvas2D の中から転送経路を選びます。メインスレッドをブロックしてみてください。Worker 経路なら表示は途切れません。",
    crossOriginIsolated: "クロスオリジン分離",
    transportMode: "転送モード",
    uiClockLabel: "UI / Shell クロック",
    uiClockHint: "メインスレッド rAF 駆動。ブロック中は赤いカーソルが停止します",
    coreClockLabel: "Core / Worker クロック",
    coreClockHint: "100 万行の Core ネイティブスクロール。ボタンとは無関係に常時動作します",
    actualStall: "実際のブロック時間",
    workerFramesDuringStall: "ブロック中の Worker フレーム",
    selfDrivenFramesDuringStall: "うち Worker 自走フレーム",
    maximumWorkerFrameGap: "Worker の最大フレーム間隔",
    stallOnMainThread:
      "現在はメインスレッド経路です。ブロック中はアニメーションが止まります。だから Worker が必要なのです。",
    stallOnWorker:
      "現在は Worker 経路です。ブロック中もレンダリングクロックは Worker 内で進み続けます。",
    blockMainThread: "メインスレッドだけを 1 秒ブロック",
  },
  "ko": {
    loading: "엔진 코어를 불러오는 중(약 1MB WASM)…",
    frames: "프레임 수",
    commands: "명령 수",
    displayList: "DisplayList",
    sceneNodes: "Scene 노드",
    layoutVisited: "레이아웃 방문",
    dirtyPaint: "더티 그리기",
    placeholders: "자리표시자",
    skippedInstructions: "건너뛴 명령",
    scrollTitle: "100만 행 네이티브 가상 스크롤",
    scrollDescription:
      "100만 행 가상 리스트를 Core가 소유합니다. 스크롤 중에는 Core 안에서 완결되어 Shell을 호출하지 않고, Shell은 Core가 계획한 프리페치 윈도의 보이는 구간만 실체화합니다. 휠이나 드래그로 시험해 보세요. 오른쪽이 실시간 프레임 지표입니다.",
    listItems: "리스트 항목",
    nodesPerRow: "행당 노드 수",
    selectedRows: "선택됨",
    lastAction: "최근 작업",
    viewOrder: "보기",
    jumpToRow: (row) => `${row}번째 행으로 이동`,
    editingTitle: "canvas 네이티브 편집과 IME",
    editingDescription:
      "애플리케이션은 HTML 입력 컨트롤을 만들지 않습니다. 엔진이 canvas에 EditContext를 연결하고(지원되지 않으면 호스트가 일괄 관리하는 숨겨진 textarea로 폴백), 캐럿·선택 영역·IME 후보창 위치·클립보드·실행 취소/다시 실행을 모두 Core가 담당합니다.",
    editTransactions: "편집 트랜잭션",
    shellValue: "Shell 값",
    inputBridge: "입력 브리지",
    editingHint: "먼저 입력란을 눌러 포커스한 다음 입력하거나 입력기를 사용하세요.",
    eventsTitle: "히트 테스트와 3단계 이벤트",
    eventsDescription:
      "히트 테스트는 Core 안의 증분 BVH로 수행하고, 이벤트는 capture → target → bubble 3단계로 DOM과 동일하게 전파됩니다. 중첩된 영역을 눌러 실시간 전파 로그를 확인하세요.",
    propagationLog: "전파 로그(최신순)",
    semanticsTitle: "시맨틱 트리와 접근성 섀도 DOM",
    semanticsDescription:
      "Core가 시맨틱 트리를 내보내고 호스트가 canvas 옆 DOM 섀도 트리로 반영합니다. 스크린 리더가 읽을 수 있고 E2E는 role/label로 요소를 선택하며, 비밀번호 값은 절대 트리에 들어가지 않습니다.",
    readSemantics: "시맨틱 트리 읽기 + ‘수신인’ 포커스",
    transportTitle: "이중 클록과 폴백 체인",
    transportDescription:
      "UI 클록과 렌더링 클록은 독립적입니다. 능력 탐지가 SharedArrayBuffer, postMessage, 메인 스레드 Canvas2D 중에서 전송 경로를 고릅니다. 메인 스레드를 막아 보세요. Worker 경로에서는 화면이 계속 이어집니다.",
    crossOriginIsolated: "교차 출처 격리",
    transportMode: "전송 모드",
    uiClockLabel: "UI / Shell 클록",
    uiClockHint: "메인 스레드 rAF 구동. 차단 중 빨간 커서가 멈춥니다",
    coreClockLabel: "Core / Worker 클록",
    coreClockHint: "100만 행 Core 네이티브 스크롤로 버튼과 무관하게 계속 움직입니다",
    actualStall: "실제 차단 시간",
    workerFramesDuringStall: "차단 중 Worker 프레임",
    selfDrivenFramesDuringStall: "그중 Worker 자체 구동 프레임",
    maximumWorkerFrameGap: "Worker 최대 프레임 간격",
    stallOnMainThread:
      "지금은 메인 스레드 경로입니다. 차단하는 동안 애니메이션이 멈춥니다. 그래서 Worker가 필요합니다.",
    stallOnWorker:
      "지금은 Worker 경로입니다. 차단하는 동안에도 렌더링 클록은 Worker 안에서 계속 진행됩니다.",
    blockMainThread: "메인 스레드만 1초 차단",
  },
  "es": {
    loading: "Cargando el núcleo del motor (unos 1 MB de WASM)…",
    frames: "Fotogramas",
    commands: "Comandos",
    displayList: "DisplayList",
    sceneNodes: "Nodos del Scene",
    layoutVisited: "Nodos de layout",
    dirtyPaint: "Nodos a repintar",
    placeholders: "Placeholders",
    skippedInstructions: "Instrucciones omitidas",
    scrollTitle: "Scroll virtual nativo de un millón de filas",
    scrollDescription:
      "Una lista virtual de un millón de filas que pertenece al Core. Mientras se desplaza, todo ocurre dentro del Core y no se llama a la capa TypeScript, que sólo materializa el rango visible de la ventana de precarga que el Core planifica. Pruébalo con la rueda o arrastrando; a la derecha están las métricas de fotograma en vivo.",
    listItems: "Elementos",
    nodesPerRow: "Nodos por fila",
    selectedRows: "Seleccionadas",
    lastAction: "Última acción",
    viewOrder: "Ver",
    jumpToRow: (row) => `Ir a la fila ${row}`,
    editingTitle: "Edición nativa en canvas e IME",
    editingDescription:
      "La aplicación no crea ningún control de entrada HTML. El motor asocia EditContext al canvas (y, si no está disponible, recurre a un textarea oculto gestionado por el host), y el cursor, la selección, la posición de la ventana de candidatos del IME, el portapapeles y deshacer/rehacer los lleva el Core.",
    editTransactions: "Transacciones",
    shellValue: "Valor en la app",
    inputBridge: "Puente de entrada",
    editingHint: "Haz clic en el campo para enfocarlo y luego escribe o usa el IME.",
    eventsTitle: "Hit testing y eventos en tres fases",
    eventsDescription:
      "El hit testing se hace en el Core con un BVH incremental, y los eventos se propagan en tres fases —captura, objetivo y burbuja— igual que en el DOM. Haz clic en las zonas anidadas para ver el registro de propagación en vivo.",
    propagationLog: "Registro de propagación (más reciente primero)",
    semanticsTitle: "Árbol semántico y DOM en la sombra",
    semanticsDescription:
      "El Core exporta el árbol semántico y el host lo refleja como un árbol DOM en la sombra junto al canvas. Los lectores de pantalla funcionan, los tests E2E seleccionan por rol y etiqueta, y el valor de una contraseña nunca entra en el árbol.",
    readSemantics: "Leer el árbol semántico y enfocar «Destinatario»",
    transportTitle: "Dos relojes y cadena de degradación",
    transportDescription:
      "El reloj de la interfaz y el de renderizado son independientes. La detección de capacidades elige el transporte entre SharedArrayBuffer, postMessage y Canvas2D en el hilo principal. Prueba a bloquear el hilo principal: por la ruta del Worker la imagen sigue fluida.",
    crossOriginIsolated: "Aislamiento de origen",
    transportMode: "Transporte",
    uiClockLabel: "Reloj UI / Shell",
    uiClockHint: "Lo impulsa el rAF principal; el cursor rojo se congela al bloquear",
    coreClockLabel: "Reloj Core / Worker",
    coreClockHint:
      "Scroll nativo de un millón de filas en Core; siempre activo, sin depender del botón",
    actualStall: "Bloqueo real",
    workerFramesDuringStall: "Fotogramas del Worker durante el bloqueo",
    selfDrivenFramesDuringStall: "Fotogramas autónomos del Worker",
    maximumWorkerFrameGap: "Intervalo máximo del Worker",
    stallOnMainThread:
      "Ahora mismo va por el hilo principal: mientras esté bloqueado la animación se detiene. Por eso hace falta el Worker.",
    stallOnWorker:
      "Ahora mismo va por el Worker: aunque el hilo principal esté bloqueado, el reloj de renderizado sigue avanzando.",
    blockMainThread: "Bloquear solo el hilo principal 1 s",
  },
  "fr": {
    loading: "Chargement du cœur du moteur (environ 1 Mo de WASM)…",
    frames: "Images",
    commands: "Commandes",
    displayList: "DisplayList",
    sceneNodes: "Nœuds du Scene",
    layoutVisited: "Nœuds de mise en page",
    dirtyPaint: "Nœuds à repeindre",
    placeholders: "Placeholders",
    skippedInstructions: "Instructions ignorées",
    scrollTitle: "Défilement virtuel natif d'un million de lignes",
    scrollDescription:
      "Une liste virtuelle d'un million de lignes possédée par le Core. Pendant le défilement tout se passe dans le Core, sans appel à la couche TypeScript, qui ne matérialise que la plage visible de la fenêtre de préchauffe planifiée par le Core. Essayez à la molette ou en glissant ; les métriques d'image en direct sont à droite.",
    listItems: "Éléments",
    nodesPerRow: "Nœuds par ligne",
    selectedRows: "Sélectionnées",
    lastAction: "Dernière action",
    viewOrder: "Voir",
    jumpToRow: (row) => `Aller à la ligne ${row}`,
    editingTitle: "Édition native dans le canvas et IME",
    editingDescription:
      "L'application ne crée aucun contrôle de saisie HTML. Le moteur associe EditContext au canvas (avec repli sur un textarea masqué géré par l'hôte si nécessaire), et le curseur, la sélection, la position de la fenêtre de candidats IME, le presse-papiers et annuler/rétablir sont pris en charge par le Core.",
    editTransactions: "Transactions",
    shellValue: "Valeur applicative",
    inputBridge: "Pont de saisie",
    editingHint:
      "Cliquez d'abord dans le champ pour le focaliser, puis saisissez ou utilisez l'IME.",
    eventsTitle: "Hit testing et événements en trois phases",
    eventsDescription:
      "Le hit testing se fait dans le Core avec un BVH incrémental, et les événements se propagent en trois phases — capture, cible, bouillonnement — comme dans le DOM. Cliquez sur les zones imbriquées pour voir le journal de propagation en direct.",
    propagationLog: "Journal de propagation (du plus récent)",
    semanticsTitle: "Arbre sémantique et DOM fantôme",
    semanticsDescription:
      "Le Core exporte l'arbre sémantique et l'hôte le reflète en arbre DOM fantôme à côté du canvas. Les lecteurs d'écran fonctionnent, les tests E2E ciblent par rôle et libellé, et la valeur d'un mot de passe n'entre jamais dans l'arbre.",
    readSemantics: "Lire l'arbre sémantique et focaliser « Destinataire »",
    transportTitle: "Deux horloges et chaîne de repli",
    transportDescription:
      "L'horloge de l'interface et celle du rendu sont indépendantes. La détection de capacités choisit le transport entre SharedArrayBuffer, postMessage et Canvas2D sur le thread principal. Essayez de bloquer le thread principal : par la voie du Worker l'affichage reste continu.",
    crossOriginIsolated: "Isolation d'origine",
    transportMode: "Transport",
    uiClockLabel: "Horloge UI / Shell",
    uiClockHint: "Pilotée par le rAF principal ; le curseur rouge se fige pendant le blocage",
    coreClockLabel: "Horloge Core / Worker",
    coreClockHint:
      "Défilement Core natif d’un million de lignes, toujours actif indépendamment du bouton",
    actualStall: "Blocage réel",
    workerFramesDuringStall: "Images Worker pendant le blocage",
    selfDrivenFramesDuringStall: "Images autonomes du Worker",
    maximumWorkerFrameGap: "Intervalle maximal du Worker",
    stallOnMainThread:
      "Nous sommes sur le thread principal : pendant le blocage l'animation s'arrête. C'est précisément pourquoi le Worker est nécessaire.",
    stallOnWorker:
      "Nous sommes sur la voie du Worker : même pendant le blocage, l'horloge de rendu continue d'avancer.",
    blockMainThread: "Bloquer uniquement le thread principal 1 s",
  },
  "de": {
    loading: "Engine-Kern wird geladen (rund 1 MB WASM)…",
    frames: "Frames",
    commands: "Befehle",
    displayList: "DisplayList",
    sceneNodes: "Scene-Knoten",
    layoutVisited: "Layout-Knoten",
    dirtyPaint: "Neu zu zeichnen",
    placeholders: "Platzhalter",
    skippedInstructions: "Übersprungene Befehle",
    scrollTitle: "Natives virtuelles Scrollen über eine Million Zeilen",
    scrollDescription:
      "Eine virtuelle Liste mit einer Million Zeilen, die dem Core gehört. Während des Scrollens läuft alles im Core und die TypeScript-Schale wird nicht aufgerufen; sie materialisiert nur den sichtbaren Bereich des vom Core geplanten Vorwärmfensters. Probieren Sie es mit dem Mausrad oder durch Ziehen; rechts stehen die Frame-Metriken in Echtzeit.",
    listItems: "Einträge",
    nodesPerRow: "Knoten pro Zeile",
    selectedRows: "Ausgewählt",
    lastAction: "Letzte Aktion",
    viewOrder: "Ansehen",
    jumpToRow: (row) => `Zu Zeile ${row} springen`,
    editingTitle: "canvas-native Bearbeitung und IME",
    editingDescription:
      "Die Anwendung legt kein HTML-Eingabeelement an. Die Engine bindet EditContext an das canvas (und fällt bei fehlender Unterstützung auf ein vom Host verwaltetes verstecktes textarea zurück); Cursor, Auswahl, Position des IME-Kandidatenfensters, Zwischenablage sowie Rückgängig/Wiederherstellen übernimmt der Core.",
    editTransactions: "Transaktionen",
    shellValue: "Wert in der App",
    inputBridge: "Eingabebrücke",
    editingHint:
      "Klicken Sie zuerst in das Feld, um es zu fokussieren, und tippen Sie dann oder nutzen Sie die Eingabemethode.",
    eventsTitle: "Hit-Testing und dreiphasige Events",
    eventsDescription:
      "Das Hit-Testing läuft im Core über ein inkrementelles BVH, und Events breiten sich wie im DOM in drei Phasen aus: Capture, Ziel, Bubble. Klicken Sie in die verschachtelten Bereiche, um das Protokoll in Echtzeit zu sehen.",
    propagationLog: "Ausbreitungsprotokoll (neueste zuerst)",
    semanticsTitle: "Semantikbaum und barrierefreier Schatten-DOM",
    semanticsDescription:
      "Der Core exportiert den Semantikbaum, und der Host spiegelt ihn als DOM-Schattenbaum neben dem canvas. Screenreader funktionieren, E2E-Tests wählen über Rolle und Beschriftung, und der Wert eines Passworts gelangt nie in den Baum.",
    readSemantics: "Semantikbaum lesen und „Empfänger“ fokussieren",
    transportTitle: "Zwei Uhren und Rückfallkette",
    transportDescription:
      "Die UI-Uhr und die Rendering-Uhr sind unabhängig. Die Fähigkeitserkennung wählt den Transport zwischen SharedArrayBuffer, postMessage und Canvas2D im Hauptthread. Blockieren Sie ruhig den Hauptthread: auf dem Worker-Pfad bleibt die Darstellung durchgehend.",
    crossOriginIsolated: "Cross-Origin-Isolation",
    transportMode: "Transport",
    uiClockLabel: "UI-/Shell-Uhr",
    uiClockHint: "Vom Hauptthread-rAF angetrieben; der rote Zeiger friert beim Blockieren ein",
    coreClockLabel: "Core-/Worker-Uhr",
    coreClockHint:
      "Natives Core-Scrollen mit einer Million Zeilen, unabhängig vom Button ständig aktiv",
    actualStall: "Tatsächliche Blockade",
    workerFramesDuringStall: "Worker-Frames während der Blockade",
    selfDrivenFramesDuringStall: "Davon selbstgetriebene Worker-Frames",
    maximumWorkerFrameGap: "Maximaler Worker-Frameabstand",
    stallOnMainThread:
      "Aktuell läuft der Hauptthread-Pfad: während der Blockade steht die Animation. Genau dafür gibt es den Worker.",
    stallOnWorker:
      "Aktuell läuft der Worker-Pfad: auch während der Blockade läuft die Rendering-Uhr im Worker weiter.",
    blockMainThread: "Nur den Hauptthread 1 Sekunde blockieren",
  },
  "ru": {
    loading: "Загружается ядро движка (около 1 МБ WASM)…",
    frames: "Кадры",
    commands: "Команды",
    displayList: "DisplayList",
    sceneNodes: "Узлы Scene",
    layoutVisited: "Узлы раскладки",
    dirtyPaint: "Узлы к перерисовке",
    placeholders: "Заглушки",
    skippedInstructions: "Пропущено инструкций",
    scrollTitle: "Нативная виртуальная прокрутка миллиона строк",
    scrollDescription:
      "Виртуальный список на миллион строк принадлежит ядру. Во время прокрутки всё происходит внутри ядра и оболочка не вызывается: она лишь материализует видимый диапазон окна прогрева, которое спланировало ядро. Попробуйте колесом или перетаскиванием; справа — покадровые метрики в реальном времени.",
    listItems: "Элементы",
    nodesPerRow: "Узлов в строке",
    selectedRows: "Выбрано",
    lastAction: "Последнее действие",
    viewOrder: "Открыть",
    jumpToRow: (row) => `Перейти к строке ${row}`,
    editingTitle: "Нативное редактирование в canvas и IME",
    editingDescription:
      "Приложение не создаёт ни одного HTML-элемента ввода. Движок привязывает EditContext к canvas (а при его отсутствии откатывается к скрытому textarea под управлением хоста); каретку, выделение, положение окна кандидатов IME, буфер обмена и отмену/повтор ведёт ядро.",
    editTransactions: "Транзакции",
    shellValue: "Значение в приложении",
    inputBridge: "Мост ввода",
    editingHint:
      "Сначала щёлкните по полю, чтобы установить фокус, затем печатайте или используйте IME.",
    eventsTitle: "Hit-тестирование и трёхфазные события",
    eventsDescription:
      "Hit-тестирование выполняется в ядре через инкрементальный BVH, а события распространяются в три фазы — перехват, цель, всплытие — как в DOM. Щёлкайте по вложенным областям, чтобы увидеть журнал распространения в реальном времени.",
    propagationLog: "Журнал распространения (сначала новые)",
    semanticsTitle: "Дерево семантики и теневой DOM для доступности",
    semanticsDescription:
      "Ядро экспортирует дерево семантики, а хост зеркалит его в теневое DOM-дерево рядом с canvas. Программы чтения с экрана работают, E2E выбирает элементы по роли и подписи, а значение пароля никогда не попадает в дерево.",
    readSemantics: "Прочитать дерево семантики и сфокусировать «Получатель»",
    transportTitle: "Две тактовые оси и цепочка отката",
    transportDescription:
      "Часы интерфейса и часы рендеринга независимы. Определение возможностей выбирает транспорт между SharedArrayBuffer, postMessage и Canvas2D в главном потоке. Попробуйте заблокировать главный поток: на пути через Worker изображение остаётся непрерывным.",
    crossOriginIsolated: "Изоляция источников",
    transportMode: "Транспорт",
    uiClockLabel: "Часы UI / Shell",
    uiClockHint: "Работают от rAF главного потока; при блокировке красный курсор замирает",
    coreClockLabel: "Часы Core / Worker",
    coreClockHint:
      "Нативная прокрутка Core на миллион строк работает постоянно и не зависит от кнопки",
    actualStall: "Фактическая блокировка",
    workerFramesDuringStall: "Кадры Worker во время блокировки",
    selfDrivenFramesDuringStall: "Автономные кадры Worker",
    maximumWorkerFrameGap: "Макс. интервал кадров Worker",
    stallOnMainThread:
      "Сейчас работает путь главного потока: во время блокировки анимация останавливается. Именно поэтому нужен Worker.",
    stallOnWorker:
      "Сейчас работает путь через Worker: даже во время блокировки часы рендеринга продолжают идти.",
    blockMainThread: "Заблокировать только главный поток на 1 секунду",
  },
  "ar": {
    loading: "يجري تحميل نواة المحرّك (نحو ١ ميغابايت من WASM)…",
    frames: "الإطارات",
    commands: "الأوامر",
    displayList: "DisplayList",
    sceneNodes: "عقد Scene",
    layoutVisited: "عقد التخطيط",
    dirtyPaint: "عقد إعادة الرسم",
    placeholders: "عناصر نائبة",
    skippedInstructions: "التعليمات المتخطاة",
    scrollTitle: "تمرير افتراضي أصلي لمليون صفّ",
    scrollDescription:
      "قائمة افتراضية بمليون صفّ تملكها النواة. أثناء التمرير يجري كلّ شيء داخل النواة دون استدعاء الغلاف، ولا يجسّد الغلاف سوى المجال المرئي من نافذة التسخين التي خطّطت لها النواة. جرّب بالعجلة أو بالسحب؛ وعلى اليسار مؤشّرات الإطارات لحظيًا.",
    listItems: "العناصر",
    nodesPerRow: "عقد لكل صف",
    selectedRows: "المحدد",
    lastAction: "آخر إجراء",
    viewOrder: "عرض",
    jumpToRow: (row) => `الانتقال إلى الصف ${row}`,
    editingTitle: "تحرير أصلي داخل canvas وIME",
    editingDescription:
      "لا ينشئ التطبيق أيّ عنصر إدخال HTML. يربط المحرّك EditContext بالـ canvas (ويتراجع عند غيابه إلى عنصر textarea مخفيّ يديره المضيف)، وتتكفّل النواة بالمؤشّر النصّي والتحديد وموضع نافذة مرشّحات IME والحافظة والتراجع والإعادة.",
    editTransactions: "معاملات التحرير",
    shellValue: "قيمة التطبيق",
    inputBridge: "جسر الإدخال",
    editingHint: "انقر الحقل أوّلًا لتفعيل التركيز، ثمّ اكتب أو استخدم طريقة الإدخال.",
    eventsTitle: "اختبار الإصابة والأحداث الثلاثية",
    eventsDescription:
      "يجري اختبار الإصابة داخل النواة عبر BVH تزايدي، وتنتشر الأحداث في ثلاث مراحل — التقاط ثمّ هدف ثمّ تصاعد — كما في DOM. انقر المناطق المتداخلة لمتابعة سجلّ الانتشار لحظيًا.",
    propagationLog: "سجلّ الانتشار (الأحدث أوّلًا)",
    semanticsTitle: "الشجرة الدلالية وDOM الظلّي للوصول",
    semanticsDescription:
      "تصدّر النواة الشجرة الدلالية ويعكسها المضيف إلى شجرة DOM ظلّية بجوار الـ canvas. تعمل قارئات الشاشة، وتختار اختبارات E2E العناصر بالدور والتسمية، ولا تدخل قيمة كلمة المرور الشجرة أبدًا.",
    readSemantics: "قراءة الشجرة الدلالية والتركيز على «المستلِم»",
    transportTitle: "الساعتان وسلسلة التراجع",
    transportDescription:
      "ساعة الواجهة وساعة العرض مستقلّتان. ويختار كشف القدرات مسار النقل بين SharedArrayBuffer وpostMessage وCanvas2D على الخيط الرئيسي. جرّب حجب الخيط الرئيسي؛ ففي مسار الـ Worker تبقى الصورة متّصلة.",
    crossOriginIsolated: "العزل بين المصادر",
    transportMode: "مسار النقل",
    uiClockLabel: "ساعة UI / Shell",
    uiClockHint: "يقودها rAF في الخيط الرئيسي؛ يتجمّد المؤشر الأحمر أثناء الحجب",
    coreClockLabel: "ساعة Core / Worker",
    coreClockHint: "تمرير نواة أصلي لمليون صف يعمل دائمًا وبمعزل عن الزر",
    actualStall: "مدة الحجب الفعلية",
    workerFramesDuringStall: "إطارات Worker أثناء الحجب",
    selfDrivenFramesDuringStall: "إطارات Worker ذاتية الدفع",
    maximumWorkerFrameGap: "أكبر فجوة بين إطارات Worker",
    stallOnMainThread:
      "المسار الحالي هو الخيط الرئيسي، فتتوقّف الحركة أثناء الحجب؛ ولهذا السبب نحتاج إلى الـ Worker.",
    stallOnWorker: "المسار الحالي هو الـ Worker، وتظلّ ساعة العرض تتقدّم داخله أثناء الحجب.",
    blockMainThread: "احجب الخيط الرئيسي فقط لثانية واحدة",
  },
  "he": {
    loading: "טוען את ליבת המנוע (כ-1MB של WASM)…",
    frames: "פריימים",
    commands: "פקודות",
    displayList: "DisplayList",
    sceneNodes: "צמתי Scene",
    layoutVisited: "צמתי פריסה",
    dirtyPaint: "צמתים לציור מחדש",
    placeholders: "מצייני מקום",
    skippedInstructions: "הוראות שדולגו",
    scrollTitle: "גלילה וירטואלית נייטיב של מיליון שורות",
    scrollDescription:
      "רשימה וירטואלית של מיליון שורות שבבעלות הליבה. בזמן הגלילה הכול קורה בתוך הליבה ואין קריאה למעטפת; היא רק מממשת את הטווח הנראה מתוך חלון החימום שהליבה תכננה. נסה בגלגלת או בגרירה; משמאל מדדי הפריים בזמן אמת.",
    listItems: "פריטים",
    nodesPerRow: "צמתים בשורה",
    selectedRows: "נבחרו",
    lastAction: "פעולה אחרונה",
    viewOrder: "הצג",
    jumpToRow: (row) => `מעבר לשורה ${row}`,
    editingTitle: "עריכה נייטיב ב-canvas ו-IME",
    editingDescription:
      "היישום אינו יוצר שום פקד קלט של HTML. המנוע קושר את EditContext ל-canvas (ובהיעדרו נסוג ל-textarea נסתר שהמארח מנהל), והסמן, הבחירה, מיקום חלון המועמדים של ה-IME, לוח הגזירים וביטול/ביצוע חוזר באחריות הליבה.",
    editTransactions: "טרנזקציות עריכה",
    shellValue: "הערך ביישום",
    inputBridge: "גשר הקלט",
    editingHint: "לחץ תחילה על השדה כדי למקד אותו, ואז הקלד או השתמש בשיטת הקלט.",
    eventsTitle: "בדיקת פגיעה ואירועים בשלושה שלבים",
    eventsDescription:
      "בדיקת הפגיעה מתבצעת בליבה באמצעות BVH מצטבר, והאירועים מתפשטים בשלושה שלבים — לכידה, יעד ובעבוע — בדיוק כמו ב-DOM. לחץ על האזורים המקוננים כדי לראות את יומן ההתפשטות בזמן אמת.",
    propagationLog: "יומן התפשטות (החדש ראשון)",
    semanticsTitle: "עץ סמנטי ו-DOM צללי לנגישות",
    semanticsDescription:
      "הליבה מייצאת את העץ הסמנטי והמארח משקף אותו לעץ DOM צללי לצד ה-canvas. קוראי מסך עובדים, בדיקות E2E בוחרות לפי תפקיד ותווית, וערך של סיסמה לעולם אינו נכנס לעץ.",
    readSemantics: "קריאת העץ הסמנטי ומיקוד ב«נמען»",
    transportTitle: "שני שעונים ושרשרת נסיגה",
    transportDescription:
      "שעון הממשק ושעון הרינדור עצמאיים. זיהוי היכולות בוחר את נתיב ההעברה מבין SharedArrayBuffer, postMessage ו-Canvas2D בתהליכון הראשי. נסה לחסום את התהליכון הראשי: בנתיב ה-Worker התצוגה נשארת רציפה.",
    crossOriginIsolated: "בידוד בין מקורות",
    transportMode: "נתיב העברה",
    uiClockLabel: "שעון UI / Shell",
    uiClockHint: "מונע ב-rAF של התהליכון הראשי; הסמן האדום קופא בזמן החסימה",
    coreClockLabel: "שעון Core / Worker",
    coreClockHint: "גלילת Core נייטיבית של מיליון שורות פועלת תמיד ואינה תלויה בכפתור",
    actualStall: "חסימה בפועל",
    workerFramesDuringStall: "פריימי Worker בזמן החסימה",
    selfDrivenFramesDuringStall: "פריימי Worker בהנעה עצמית",
    maximumWorkerFrameGap: "מרווח פריים מרבי ב-Worker",
    stallOnMainThread:
      "כרגע פועל נתיב התהליכון הראשי: בזמן החסימה האנימציה נעצרת. בדיוק בשביל זה נדרש ה-Worker.",
    stallOnWorker: "כרגע פועל נתיב ה-Worker: גם בזמן החסימה שעון הרינדור ממשיך להתקדם בתוכו.",
    blockMainThread: "חסום רק את התהליכון הראשי לשנייה אחת",
  },
};

/** Resolves the message bundle for a site language, defaulting to the root locale. */
export function playgroundMessages(lang: string | undefined): PlaygroundMessages {
  return MESSAGES[lang ?? ""] ?? MESSAGES["zh-Hans"]!;
}
