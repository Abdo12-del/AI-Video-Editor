# تحليل المتطلبات والـArchitecture

## قرار الـStack

| المجال | الاختيار | السبب |
|---|---|---|
| Desktop shell | Electron 44.4.5 | حاوية Windows فعلية، وصول آمن إلى dialogs/filesystem/processes من Main، ومثبّت NSIS قابل للتوزيع. React داخل Electron لا يعني تشغيل Chrome خارجيًا. |
| الواجهة | React 19 + TypeScript + Vite (`electron-vite`) | واجهة تفاعلية ومكوّنات قابلة للتقسيم مع دورة تطوير سريعة وأنواع مشتركة بين Main والواجهة. |
| معالجة الفيديو | FFmpeg/FFprobe (`ffmpeg-static`, `ffprobe-static`) | محرك محلي، قابل للتكرار، بوسائط منظمة. في التطوير يفضّل الثنائية المرفقة ويمكن تجاوزها صراحةً بـ`FFMPEG_PATH`/`FFPROBE_PATH`. في التطبيق المثبت تُفضّل ثنائيات Windows المرفقة داخل `app.asar.unpacked` ولا يوجد fallback صامت إلى `PATH`. لا تُنشأ أوامر shell من نص المستخدم أو النموذج؛ التنفيذ بـ`spawn(executable, args)` فقط. |
| المشروع/التخزين | `project.json` داخل مجلد المشروع في MVP | المونتاج هنا مستند مشروع صغير مرن، قابل للنقل، مع مراجع للملفات الأصلية بدل نسخها. مجلدات `cache/`, `thumbnails/`, `waveforms/`, `transcripts/`, `previews/`, `exports/` جاهزة. SQLite خيار مرحلة لاحقة لفهرس المشاريع والأصول الكبير؛ لا فائدة من فرض قاعدة بيانات على MVP محمول من ملف واحد. |
| التحليل المحلي | FFprobe + مرشحات FFmpeg | لا يتطلب API ولا رفع فيديو؛ يكشف الصمت، انتقالات المشاهد، متوسط/أقصى مستوى صوت، والبيانات الوصفية. |
| الكلام | Whisper.cpp اختياري | تشغيل محلي وخصوصية أفضل. يختار المستخدم executable والنموذج؛ إن لم يضبطهما التطبيق يظل التحرير والتحليل الصوتي يعملان. |
| وكيل اللغة الطبيعية | Google Gemini API (`gemini-3.8-flash`) مع function calling + سجل أدوات محلي قابل للتوسعة | Gemini هو محرك الوكيل الحالي عند إعداد المفتاح. يرسل Main الطلب أولًا، ثم يشارك فقط نتائج أدوات السياق المطلوبة. كود Ollama القديم محفوظ لكنه غير مستخدم في واجهة الوكيل. غياب المفتاح لا يعطل المحرر أو بعض قواعد الأوامر المحلية. |
| اختبارات | Vitest | اختبارات وحدة سريعة، واختبارات تكامل منفصلة gated تستخدم FFmpeg حقيقيًا عند تشغيل `npm run test:media`. رحلة الخدمة لا تطلق نافذة Electron وتستخدم ردود Agent مخططة؛ الاتصال الحي بـGemini اختبار opt-in مستقل. |

## فحص ثنائيات الوسائط والإصدار

عند بدء Main process يُشغّل `FFmpeg -version` و`FFprobe -version` على المسارين المحلولين فعليًا. النتيجة تُسجّل محليًا وتُعرض في الواجهة إذا لم تكن الأداتان جاهزتين؛ وتبقى وظائف المشروع الأساسية متاحة لكن لا يبدأ الاستيراد/التحليل/التصدير بأخطاء مبهمة. يوفر التطبيق أيضًا `--media-health-check` لفحص النسخة المثبتة دون فتح النافذة. فحص `scripts/verify-win-packaging.cjs` يمنع البناء المتقاطع غير الآمن على Linux/macOS؛ لأن `ffmpeg-static` يحمل ثنائي المضيف. `npm run dist:win` مخصص لـWindows x64 ويشغّل الاختبارات، يبني NSIS، ثم يثبت التطبيق بصمت ويفحص مسارات `app.asar.unpacked`. أضيف إلى smoke test تشغيل الثنائيات المثبتة على ملف قصير بمسارات Unicode ومسافات، لكنه لا يختبر واجهة Electron ولا مسار `renderExport` داخل النسخة المثبتة. سير عمل GitHub Actions في `.github/workflows/windows-release.yml` مهيأ لتنفيذ ذلك على Windows runner؛ لم يُنفذ في بيئة Linux الحالية.

## ما يعمل محليًا وما قد يتصل بالشبكة

- **محلي دائمًا:** الملفات الأصلية، `project.json`، thumbnails وموجات صوتية مشتقة، كشف الصمت/المشاهد ومستوى الصوت، عمليات الـTimeline، السجل، FFmpeg export، ومحلل الأوامر المحدد.
- **Whisper.cpp:** محلي بالكامل بعد إعداد binary/model. لا تُحمّل النماذج تلقائيًا.
- **Google Gemini API:** اختياري ويتطلب إدخال المستخدم للمفتاح من Settings. يُحفظ المفتاح مشفرًا عبر Electron `safeStorage` في ملف منفصل داخل `app.getPath('userData')` (على Windows يستخدم DPAPI)، ولا يمر إلى الـrenderer بعد الحفظ ولا يُكتب في Settings JSON أو السجلات. تستخدم الشبكة رأس `x-goog-api-key` لا query string. ترسل الجولة الأولى طلب المستخدم فقط؛ يطلب النموذج أدوات سياق محلية حسب حاجته، ثم تُرسل نتائج الأدوات المحددة إلى Gemini. قد تتضمن تلك النتائج نص التفريغ/العناوين عند طلبها، لكن المسارات المحلية والصوت والفيديو الخام لا تُرسل تلقائيًا. أخطاء المزود تُختزل إلى رموز عامة ولا تشمل المفتاح.
- **Ollama:** بقي كوده وإعداداته للتوافق، لكنه غير مستخدم من واجهة Agent الحالية؛ Gemini هو المزود الفعلي الوحيد للوكيل.
- **مزودات Cloud أخرى:** لا يوجد OpenAI أو Anthropic أو مزود آخر نشط للوكيل. سجل الأدوات مستقل عن Gemini API، بحيث يمكن الحفاظ على نفس الواجهة عند إضافة provider آخر لاحقًا مع opt-in صريح.

## حدود الأمان

1. `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; الـrenderer لا يملك Node ولا وصولًا مباشرًا إلى النظام.
2. كل قدرة تمر عبر API ضيق في `preload` وIPC مسمى.
3. Gemini لا يستدعي shell ولا يختار executable أو filter أو file path. يرى فقط الأدوات المسجلة في `src/main/agentToolRegistry.ts`، وكل Handler يتحقق من arguments وينفذ وظائف التطبيق المحددة. يسجل كل feature جديد أدواته عبر registry بدل تعديل loop المزود أو استعمال أوامر نظام.
4. دوال Timeline المشتركة تتحقق من المعرفات، المدد، النطاقات ومستوى الصوت. FFmpeg يُشغّل بوسائط منفصلة، ومكونات filter تُبنى من قيم رقمية/enums تم التحقق منها.
5. لا يُعدّل الأصل؛ كل قص أو حذف عبارة عن حدود مصدر داخل Timeline، ويُكتب ملف جديد عند التصدير.
6. عمليات الحذف الجماعية/الخطط الذكية المستقبلية يجب أن تمر عبر بطاقة مراجعة قبل التطبيق. حذف الصمت في MVP عملية قابلة للتراجع ويُعرض ملخصها في المحادثة.

## كيف يرتبط AI بالـTimeline؟

`User request → Gemini generateContent/functionCall → Main agent loop → registered tool validation/execution → functionResponse → Gemini follow-up → final response + updated project → preview mapping / user-confirmed export`.

لا يضم prompt كامل `ProjectData`: الجولة الأولى ترسل الطلب فقط. يختار Gemini أدوات مثل `get_project_state`, `get_media`, `get_timeline`, `get_transcript`, `get_scenes`, `get_audio_analysis` أو `find_silences` عند الحاجة. كل Handler يعيد حقولًا محددة ومحدودة الحجم؛ لا يعيد مسارات الأصول المحلية ولا يرفع ملفات. `registerAgentTool` يسمح لكل ميزة جديدة بتسجيل function schema وHandler مستقل، بينما يبقى Gemini loop والـprovider دون قائمة تنفيذ جامدة. لتنفيذ الخطوات المتعددة، لا يُسمح بأكثر من تعديل مشروع واحد ضمن استجابة function-call واحدة؛ تُعاد نتيجة التعديل مع بصمة revision مبهمة، ثم تُطلب جولة جديدة. أي فشل أو تعارض revision يوقف بقية الخطة مع إبقاء التعديلات السابقة الناجحة؛ التغييرات الكبيرة تتوقف أيضًا لمراجعة المستخدم.

تشمل الأدوات الفعلية الحالية التحليل/التفريغ المحلي، حذف الصمت والنطاقات، تقسيم/قص/نقل/إضافة مقطع فيديو، مستوى الصوت المضمّن، نسب الأبعاد، مزج الصوت المستقل (إضافة/قص/نقل/كسب/كتم/حذف)، إضافة/توليد/تحديث/حذف ترجمة، Undo/Redo، ومعاينة حالة المشروع. يدعم المحرر أيضًا لوحة Subtitle Editor في العربية/الإنجليزية/الفرنسية مع توقيت يدوي قابل للتراجع. `find_repeated_segments` يبحث في نص تفريغ موجود ويعلن بوضوح أنه matching نصي، لا كشف تكرار بصري. `find_short_candidates` يرتب نطاقات من نص التفريغ المحلي، وتغطية الكلام، والتنوع اللفظي، وحدود المشاهد والصمت الفعلية؛ لا يصف محتوى الصورة ولا يتنبأ بالانتشار. `create_short_from_range` يقتطع الفيديو والموسيقى والترجمة ضمن النطاق، يزيحها إلى الصفر ويضبط إطار 9:16؛ الاقتطاعات الكبيرة تنتظر موافقة المستخدم، ثم تُطبق كتعديل واحد قابل للتراجع. لا توجد بعد أوصاف بصرية للأشخاص/الأشياء أو Smart Crop/Tracking أو نصوص متحركة وانتقالات. `export_video` يجهز الإعدادات ويطلب تأكيدًا من المستخدم في نافذة التصدير؛ لا يبدأ كتابة ملف بلا اختيار المسار والضغط على Start Export.

الـTimeline هي الحالة الفعلية للمونتاج: كل `TimelineClip` يشير إلى `mediaId` و`sourceIn/sourceOut` وموضعه وتركيز الصوت. مسار `track-music` مستقل عن صوت الفيديو المضمّن، وتُزامن معاينته مع رأس التشغيل؛ يصنع FFmpeg له مرشحات trim/gain/delay ثم يمزجه مع الصوت الأصلي عند التصدير. أداة `remove_silence` تقرأ فترات الصمت المخزنة في التحليل، تقاطعها مع نطاق كل مقطع، تنشئ الأجزاء المحتفظ بها، ثم تعيد رصّها زمنيًا. إنشاء Short يقصّ النطاقات المتقاطعة على مسارات الفيديو/الموسيقى والترجمة ويعيد توقيتها. تظل الملفات الأصلية كما هي. جميع تغييرات Timeline تسجل snapshot للتراجع والإعادة؛ والحذف الكبير/Short المقترح من النموذج يتوقف عند بطاقة مراجعة مرتبطة بنسخة المشروع.

## مخطط مشروع MVP

```text
MyProject/
├── project.json          # schemaVersion, media refs, analysis, timeline, history, chat
├── media/                # فارغ افتراضيًا؛ لا ننسخ الأصول تلقائيًا
├── cache/                # WAV مؤقت/بيانات مشتقة قابلة لإعادة الإنشاء
├── thumbnails/           # صور مصغرة
├── waveforms/            # موجات صوتية مشتقة محليًا
├── transcripts/          # تفريغ Whisper المحلي
├── previews/             # مساحة cache لرندرات مستقبلية
└── exports/              # مكان افتراضي؛ يختار المستخدم هدف التصدير
```

### حقول البيانات الرئيسية

```ts
ProjectData {
  schemaVersion, id, name, createdAt, updatedAt,
  media: MediaAsset[],
  analysisByMedia: Record<mediaId, AnalysisResult>,
  timeline: { tracks: TimelineTrack[], clips: TimelineClip[] },
  subtitles: TranscriptSegment[],
  exportSettings: ExportSettings,
  chatMessages: ChatMessage[],
  operations: EditOperation[],
  history: { undo: EditSnapshot[], redo: EditSnapshot[] }
}
```

`MediaAsset` يخزن مسار الأصل، المدة، الأبعاد، FPS، codec وحالة الصوت. `AnalysisResult` يحوي `scenes`, `silences`, `transcript` (كلمات إن وفّرها Whisper)، `audioMetrics`, `quality`, warnings وتوقيت التحليل. مسار الأصل يبقى مرجعًا مطلقًا لتجنب نسخه، وإن تغير يدعم التطبيق Relink؛ أما الصور المشتقة فتُحفظ بمسارات نسبية داخل المشروع حتى تبقى صالحة عند نقل مجلده.

عند الانتقال إلى SQLite تُطبع هذه المصفوفات إلى جداول `projects`, `media`, `scenes`, `transcripts`, `transcript_words`, `timeline_tracks`, `timeline_clips`, `audio_analysis`, `ai_operations`, `chat_messages`, `exports`, `settings`. تبقى أصول المشروع والـTimeline قابلة للتصدير/الترحيل بفضل `schemaVersion`.

## حالة التنفيذ والاختبار (2026-09-23)

| القدرة | التصنيف | ما يثبته الدليل وما لا يثبته |
|---|---|---|
| Timeline/ProjectStore/Undo/Redo | **Implemented · Unit-tested (Linux)** | الاختبارات السريعة تمر على منصة Linux؛ لا تختبر نافذة Electron أو Windows. |
| اكتشاف ثنائيات FFmpeg/FFprobe وتشغيل `spawn` بدون shell | **Implemented · Requires FFmpeg** | أضيف اختبار تكامل حقيقي للمسارات؛ `ffprobe-static` موجود ويجتاز `-version`، لكن ثنائي FFmpeg المحلول غائب، لذلك توقف `npm run test:media` قبل إنشاء الوسائط ولم يحدث تصدير فعلي. |
| استيراد الوسائط، thumbnails/waveforms، التحليل، قص الموسيقى/الفيديو، مزج الصوت، ASS subtitles وShort export | **Implemented · Integration test prepared · Untested here** | `npm run test:media` يولّد فيديوًا ومسار موسيقى اصطناعيين في مسارات عربية/Unicode مع مسافات، ويختبر المزامنة الصوتية بعد الاقتطاع؛ يلزم تشغيله على جهاز يملك الثنائيات. |
| رحلة ProjectStore→Agent tools→preview state→export | **Implemented · Gemini and Electron dialogs mocked · Requires FFmpeg** | ProjectStore وملفات الوسائط وAgent handlers وFFmpeg حقيقية عند توفرها؛ ردود Gemini وdialogs scripted. الاختبار لا يفتح UI ولا يشغّل مشغل المعاينة. |
| Agent Gemini وأدواته | **Implemented · Unit-tested with mocks · Requires Gemini for a live test** | الاختبارات الوهمية تثبت حلقة الأدوات فقط. أضيف `npm run test:live-agent` لطلب اختياري حي؛ فشل شرط المتغير هنا قبل تشغيل Vitest، ولم يُرسل أي طلب. |
| Windows x64 installer/runtime | **Windows-only · Untested in this session** | NSIS/`app.asar.unpacked` وsmoke للثنائيات ومسارات Unicode مهيأة في CI؛ لا يثبت نجاح Windows إلا تشغيل workflow فعليًا. |
| Shorts candidates | **Experimental** | ranking من transcript وحدود الصمت/المشاهد وخصائص زمنية؛ لا يثبت المعنى البصري أو احتمالية الانتشار. |
| فهم بصري حقيقي، Smart Crop/Tracking، Text Layers، Transitions/Effects | **Not implemented** | لا يوجد تنفيذ أو اختبار لهذه الميزات في هذا الفرع. |

في التشغيل الأخير: `npm test` = **44 passed, 3 skipped**؛ الاختبارات المتخطاة هي تكاملا FFmpeg واختبار Gemini الحي. `npm run typecheck`, `npm run build`, و`git diff --check` نجحت على Linux. شُغّل `npm run test:media` لكن فشل فحص البداية صراحةً لأن FFmpeg غير موجود (FFprobe الثابت موجود وقابل للتشغيل)؛ وشُغّل wrapper `npm run test:live-agent` مع غياب متغير المفتاح، فرفض البدء قبل Vitest ولم يحدث اتصال. لم يُبنَ/يُثبت التطبيق على Windows. هذه ليست ادعاءات نجاح للتصدير أو واجهة Desktop أو النسخة النهائية.

## الخطة المرحلية

### Phase 1 — الوظائف الموجودة في هذا الفرع

Desktop shell، إنشاء/فتح مشروع، استيراد فيديو وصوت، معاينة وترتيب Timeline، split/trim/move/delete، مسار موسيقى مستقل ومعاينته ومزجه عند التصدير، محرر ترجمة، Undo/Redo، تحليل FFmpeg للصمت/المشاهد/مستوى الصوت، Whisper.cpp اختياري، وتصدير متعدد الحاويات/الدقة/الترميز. وكيل Gemini الأساسي وأدوات السياق والتحرير والصوت والترجمة وShorts تعمل عند إعداد مفتاح آمن. اقتطاعات Shorts الكبيرة تخضع للمراجعة.

### Phase 2

تحرير متقدم للنصوص والعناوين والتأثيرات والانتقالات، تحرير توقيت كلمات التفريغ، واجهة AI Shorts بقائمة مرئية للأدلة والمرشحات، واختبارات end-to-end بوسائط مرجعية حقيقية.

### Phase 3

فهم بصري فعلي محلي بإطارات منتقاة ونموذج رؤية محلي اختياري، كاش waveform/إطارات أدق، قوالب اجتماعية متقدمة وtracking/smart crop مع إظهار المصدر والثقة وعدم اختلاق أوصاف.

### Phase 4

Workers/proxy media وتسريع عتادي، إدارة مكتبات مشاريع كبيرة بـSQLite، وتحسينات صوت/إزالة ضوضاء/خلفية وB-roll، مع الحفاظ على opt-in الصريح لأي خدمة Cloud.
