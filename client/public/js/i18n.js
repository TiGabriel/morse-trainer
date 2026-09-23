/**
 * Localization engine — Romanian (default) / English, entirely local,
 * zero network dependency (this file and its dictionaries are static
 * assets served by the same LAN server as everything else).
 *
 * Mirrors the existing light/dark theme pattern exactly:
 *   - each page has a tiny inline <head> script that reads
 *     localStorage synchronously and sets an attribute on <html>
 *     BEFORE the stylesheet/body paint, so there's no flash of the
 *     wrong language, the same way morseTrainerTheme avoids a flash
 *     of the wrong theme.
 *   - this file just needs to be loaded (before nav.js, which wires
 *     the toggle button and performs the first full-page translation
 *     pass) and exposes the API every other page script calls.
 *
 * Usage from any page script (all files share one global scope, no
 * bundler/modules, same convention as nav.js/character-pool.js/etc.):
 *   t('common.start')                                 -> "Începe" / "Start"
 *   t('practice.progress', { current: 4, total: 20 })  -> "Progres: 4 / 20"
 *   I18N.setLanguage('en')
 *   I18N.applyTranslations()                           // re-scan the DOM
 *   document.addEventListener('morseTrainer:languageChanged', fn)
 *
 * Static HTML text is translated declaratively via data attributes:
 *   <h1 data-i18n="hub.title">Individual Training</h1>
 *   <input data-i18n-placeholder="auth.username" placeholder="Username" />
 *   <button data-i18n-title="nav.themeToLight" title="...">
 * Dynamic/generated text (chip labels, status messages, results the
 * app builds at runtime) calls t(...) directly at the point the
 * string is produced — there is no DOM node to attach data-i18n to
 * until that JS runs.
 *
 * IMPORTANT — never translate training/exercise DATA: Morse-derived
 * characters, radiogram/reception/transmission content, student
 * answers, usernames, names, class names, scores, WPM/Hz numbers.
 * Only application UI chrome goes through t().
 */
(function () {
    const LANG_KEY = 'morseTrainerLanguage';
    const DEFAULT_LANG = 'ro';
    const SUPPORTED_LANGS = ['ro', 'en'];

    function getStoredLanguage() {
        try {
            const stored = localStorage.getItem(LANG_KEY);
            return SUPPORTED_LANGS.includes(stored) ? stored : DEFAULT_LANG;
        } catch {
            return DEFAULT_LANG;
        }
    }

    // The inline <head> script in every page already set this
    // synchronously before this file ever runs, so this is just a
    // cheap read of what's already on the element (falls back to a
    // fresh localStorage read for any context where that inline
    // script didn't run).
    function currentLanguage() {
        const attr = document.documentElement.dataset.lang;
        return SUPPORTED_LANGS.includes(attr) ? attr : getStoredLanguage();
    }

    /** Dot-path lookup, e.g. get(RO, 'common.start'). */
    function get(dict, path) {
        return path.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), dict);
    }

    function interpolate(str, params) {
        if (!params) return str;
        return str.replace(/\{(\w+)\}/g, (match, name) => (
            Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
        ));
    }

    function t(key, params) {
        const lang = currentLanguage();
        let value = get(DICTS[lang], key);
        if (value === undefined && lang !== 'en') value = get(DICTS.en, key);
        if (value === undefined) return key;
        return interpolate(value, params);
    }

    function setLanguage(lang) {
        const next = SUPPORTED_LANGS.includes(lang) ? lang : DEFAULT_LANG;
        document.documentElement.dataset.lang = next;
        document.documentElement.lang = next;
        try {
            localStorage.setItem(LANG_KEY, next);
        } catch {
            // Private browsing / storage disabled — language still applies
            // for this page load, it just won't be remembered on the next.
        }
        applyTranslations();
        document.dispatchEvent(new CustomEvent('morseTrainer:languageChanged', { detail: { language: next } }));
    }

    function applyOne(el, attr, setter) {
        const key = el.getAttribute(attr);
        if (!key) return;
        let params;
        const rawParams = el.getAttribute(attr + '-params');
        if (rawParams) {
            try {
                params = JSON.parse(rawParams);
            } catch {
                params = undefined;
            }
        }
        setter(el, t(key, params));
    }

    function applyTranslations(root) {
        const scope = root || document;
        scope.querySelectorAll('[data-i18n]').forEach((el) => applyOne(el, 'data-i18n', (node, text) => { node.textContent = text; }));
        scope.querySelectorAll('[data-i18n-html]').forEach((el) => applyOne(el, 'data-i18n-html', (node, text) => { node.innerHTML = text; }));
        scope.querySelectorAll('[data-i18n-placeholder]').forEach((el) => applyOne(el, 'data-i18n-placeholder', (node, text) => { node.placeholder = text; }));
        scope.querySelectorAll('[data-i18n-title]').forEach((el) => applyOne(el, 'data-i18n-title', (node, text) => { node.title = text; }));
        scope.querySelectorAll('[data-i18n-aria-label]').forEach((el) => applyOne(el, 'data-i18n-aria-label', (node, text) => { node.setAttribute('aria-label', text); }));
        scope.querySelectorAll('[data-i18n-value]').forEach((el) => applyOne(el, 'data-i18n-value', (node, text) => { node.value = text; }));
    }

    // -----------------------------------------------------------------
    // Dictionaries. One namespace per app area, RO and EN kept in the
    // same shape/order so a missing key is easy to spot by diffing the
    // two objects. Each object ends with `_end: true` purely as a
    // stable anchor other edits can insert new namespaces above.
    // -----------------------------------------------------------------
    const RO = {
        common: {
            start: 'Începe', stop: 'Oprire', pause: 'Pauză', resume: 'Reia',
            restart: 'Reîncepe', finish: 'Finalizează', submit: 'Trimite',
            cancel: 'Anulează', save: 'Salvează', close: 'Închide', clear: 'Șterge',
            back: 'Înapoi', next: 'Următorul', apply: 'Aplică', confirm: 'Confirmă',
            delete: 'Șterge', edit: 'Editează', export: 'Exportă', print: 'Printează',
            loading: 'Se încarcă…', saving: 'Se salvează…', error: 'Eroare',
            success: 'Succes', yes: 'Da', no: 'Nu', ok: 'OK', none: '— niciunul —',
            all: 'Toate', settings: 'Setări', results: 'Rezultate', progress: 'Progres', done: 'Terminat',
            correct: 'Corect', incorrect: 'Incorect', missing: 'Lipsă', extra: 'În plus',
            accuracy: 'Acuratețe', errors: 'Erori', score: 'Scor', grade: 'Notă',
            date: 'Data', time: 'Ora', duration: 'Durată', total: 'Total',
            average: 'Medie', best: 'Cel mai bun', worst: 'Cel mai slab',
            name: 'Nume', class: 'Clasă', status: 'Stare', active: 'Activ',
            inactive: 'Inactiv', reset: 'Resetează', refresh: 'Reîmprospătează',
            search: 'Caută…', volume: 'Volum', tone: 'Frecvență ton (Hz)',
            wpm: 'VPM (viteză caractere)', farnsworth: 'VPM Farnsworth', frequency: 'Frecvență',
            correct2: 'corect', missing2: 'lipsă', extra2: 'în plus',
            characters: 'caractere', of: 'din', confirmDelete: 'Sigur ștergi acest element?',
            unsavedNote: 'Modificările nesalvate se vor pierde.', play: 'Redă', wpmShort: 'VPM',
            backToSettings: '← Înapoi la setări', backToSettingsShort: 'Schimbă setările',
            resultNotSaved: 'Rezultatul nu a putut fi salvat în istoric: {message}',
            groupsUnit: 'grupuri', farnsworthNote: ' (Farnsworth {wpm} VPM)', targetUnit: 'țintă',
        },
        nav: {
            home: 'Acasă', dashboard: 'Panou profesor', groupSessions: 'Sesiuni de grup',
            gradebook: 'Catalog electronic', morseAlphabet: 'Alfabet Morse',
            statistics: 'Statistici', individualTraining: 'Pregătire individuală',
            logout: 'Deconectare', themeToLight: 'Comută la tema deschisă',
            themeToDark: 'Comută la tema închisă', languageLabel: 'Limbă',
            switchToRomanian: 'Comută în română', switchToEnglish: 'Switch to English',
        },
        auth: {
            login: 'Autentificare', username: 'Nume utilizator', password: 'Parolă',
            signIn: 'Autentifică-te', loggedIn: 'Autentificat', signedInAs: 'Autentificat ca',
            invalidCredentials: 'Nume de utilizator sau parolă incorecte.',
            accountDisabled: 'Cont dezactivat.', loginFailed: 'Autentificare eșuată.',
            couldNotReachServer: 'Nu s-a putut contacta serverul',
            checkingAccess: 'Se verifică accesul…', serverOnline: 'Server online', serverOnlineUpper: 'Server ONLINE', serverOfflineUpper: 'Server OFFLINE', serverChecking: 'Server …',
            checkingServerStatus: 'Se verifică starea serverului…',
            shareTitle: 'Distribuie această adresă elevilor',
            shareHint: 'Elevii din aceeași rețea de clasă pot deschide acest URL în orice browser.',
            noLan: 'Nicio adresă LAN detectată — verifică conexiunea la rețea.',
            myProfile: 'Profilul meu', rank: 'Grad', profileNote: 'Doar profesorul tău poate edita aceste informații sau reseta parola.',
            openTeacherDashboard: 'Deschide panoul profesorului', startIndividualTraining: 'Începe pregătirea individuală',
            joinGroupSession: 'Alătură-te unei sesiuni de grup', noClassAssigned: '— nicio clasă asignată —',
            roleTeacher: 'profesor', roleStudent: 'elev',
            errUsernamePasswordRequired: 'Numele de utilizator și parola sunt obligatorii.',
            errTooManyAttempts: 'Prea multe încercări eșuate. Încearcă din nou peste câteva minute.',
            errAccountDeactivated: 'Acest cont a fost dezactivat. Contactează-ți profesorul.',
        },
        teacher: {
            dashboardTitle: 'Panou <span class="accent">Profesor</span>', dashboardSubtitle: 'Administrează clase, elevi, sesiuni de grup și note.',
            openGroupSessions: 'Deschide Sesiunile de Grup →', searchByClass: 'Caută după clasă…',
            allStatuses: 'Toate stările', statusCreated: 'Creată', statusWaiting: 'În așteptare',
            statusRunning: 'În desfășurare', statusPaused: 'Pauzată', statusFinished: 'Finalizată', statusCancelled: 'Anulată',
            type: 'Tip', difficulty: 'Dificultate', exercises: 'Exerciții', actions: 'Acțiuni',
            studentGrades: 'Note elevi', studentGradesHint: 'Rezultate practică + test, din aceleași date ca la Statistici.',
            searchNameUsername: 'Caută nume, utilizator…', allClasses: 'Toate clasele',
            username: 'Utilizator', practiceAttempts: 'Încercări practică', practiceAccuracy: 'Acuratețe practică',
            testSessions: 'Sesiuni test', testAvgScore: 'Scor mediu test', testPassRate: 'Rată promovare test',
            classes: 'Clase', newClass: '+ Clasă nouă', students: 'Elevi', newStudent: '+ Elev nou',
            searchNameUsernameRank: 'Caută nume, utilizator, grad…', lastName: 'Nume', firstName: 'Prenume',
            morsePreview: 'Previzualizare audio Morse', morsePreviewHint: 'Generează și redă audio local — fără rețea sau fișiere.',
            text: 'Text', textToConvert: 'Scrie textul de convertit în audio Morse…',
            diffBeginner: 'Începător', diffEasy: 'Ușor', diffMedium: 'Mediu', diffHard: 'Dificil',
            generateRandomText: 'Generează text aleator', blankSameAsWpm: '(gol = la fel ca VPM)',
            replayPolicy: 'Politică redare', replayPolicyHint: '(demonstrație pentru restricțiile viitoare de test)',
            replayUnlimited: 'Nelimitat (redare permisă)', replayOnce: 'O singură redare', replayDisabled: 'Dezactivat (fără redare)',
            autoplay: 'Redare automată (pornește imediat ce se încarcă)',
            morseCode: 'Cod Morse', idle: 'Inactiv', playCount: 'Număr redări',
            confirmDeleteClass: 'Ștergi clasa "{name}"? Elevii rămân, dar vor fi neasignați.',
            confirmDeleteStudent: 'Ștergi elevul "{name}"? Această acțiune nu poate fi anulată.',
            confirmResetPassword: 'Resetezi parola pentru "{name}"?',
            noClassesYet: 'Nicio clasă încă. Creează una pentru a începe.',
            reassignBeforeDelete: 'Reasignează sau elimină elevii înainte de a șterge.',
            rename: 'Redenumește', deactivate: 'Dezactivează', reactivate: 'Reactivează', resetPw: 'Resetează parola',
            newClassModalTitle: 'Clasă nouă', className: 'Nume clasă', classNamePlaceholder: 'ex. Comunicații Radio 101', create: 'Creează',
            errClassNameRequired: 'Numele clasei este obligatoriu.', toastClassCreated: 'Clasă creată.',
            renameModalTitle: 'Redenumește "{name}"', toastClassRenamed: 'Clasă redenumită.',
            toastClassDeactivated: 'Clasă dezactivată.', toastClassReactivated: 'Clasă reactivată.',
            deleteClassModalTitle: 'Ștergi "{name}"?', deleteClassNote: 'Această acțiune elimină definitiv clasa. Nu poate fi anulată.',
            toastClassDeleted: 'Clasă ștearsă.', noStudentsMatch: 'Niciun elev nu corespunde filtrelor curente.',
            newStudentModalTitle: 'Elev nou', tempPassword: 'Parolă temporară', tempPasswordPlaceholder: 'Minim 8 caractere',
            noClass: '— Fără clasă —', errUsernameRequired: 'Numele de utilizator este obligatoriu.',
            errPasswordLength: 'Parola trebuie să aibă cel puțin 8 caractere.', toastStudentCreated: 'Elev creat.',
            editStudentModalTitle: 'Editează elevul', toastStudentUpdated: 'Elev actualizat.',
            toastStudentDeactivated: 'Elev dezactivat.', toastStudentReactivated: 'Elev reactivat.',
            resetPasswordTitle: 'Resetează parola pentru {username}',
            resetPasswordNote: 'O nouă parolă aleatoare va fi generată și afișată o singură dată mai jos. Sesiunile deschise ale acestui elev vor fi închise.',
            generateNewPassword: 'Generează parolă nouă',
            writeDownPassword: 'Notează acum — nu va mai fi afișată din nou. Apasă Anulează pentru a închide.',
            toastPasswordReset: 'Parolă resetată.', noSessionsMatch: 'Nicio sesiune de grup nu corespunde filtrelor curente.',
            open: 'Deschide', somethingWrong: 'A apărut o problemă.',
            playing: 'Redare…', finished: 'Finalizat', stopped: 'Oprit', replayBlocked: 'Redare blocată de politica curentă',
            ready: 'Pregătit', emptyParens: '(gol)', unsupportedCharsSkipped: 'Caractere neacceptate omise: {chars}',
            enterTextFirst: 'Introdu mai întâi un text.',
        },
        groupSession: {
            connectionLost: 'Conexiune pierdută — se reconectează…',
            title: '<span class="accent">Sesiuni</span> de grup', subtitle: 'Sesiunile pe care profesorul le-a deschis pentru clasa ta.',
            noClassNotice: 'Nu ești asignat unei clase încă — cere-i profesorului să te asigneze uneia.',
            waitingRoom: 'Sală de așteptare', waiting: 'în așteptare', instructions: 'Instrucțiuni:',
            imReady: 'Sunt pregătit', readyHint: 'Apăsarea pe "Sunt pregătit" deblochează și redarea audio în acest browser — necesară o dată per sesiune, conform regulilor browserului.',
            leaveSession: 'Părăsește această sesiune', getReady: 'Pregătește-te…', replay: 'Redă din nou',
            yourAnswer: 'Răspunsul tău', sessionComplete: 'Sesiune finalizată', greatWork: 'Bună treabă.',
            item: 'Element', answer: 'Răspuns', mark: 'Calificativ', backToSessions: 'Înapoi la sesiuni',
            itemProgress: 'Elementul {current} din {total}', noSessionsAvailable: 'Nicio sesiune disponibilă momentan pentru clasa ta.',
            joinSession: 'Alătură-te', sessionStatusCreated: 'creată', sessionStatusWaiting: 'în așteptare',
            sessionStatusRunning: 'în desfășurare', sessionStatusPaused: 'pauzată', sessionStatusFinished: 'finalizată', sessionStatusCancelled: 'anulată',
            waitingForTeacher: 'Se așteaptă ca profesorul să înceapă sesiunea.',
            readyCount: '{ready} pregătiți · {connected} conectați din {total}', couldNotJoin: 'Nu s-a putut realiza conectarea la sesiune.',
            sessionPaused: 'Sesiunea este pauzată de profesor.', sessionCancelled: 'Sesiunea a fost anulată de profesor.',
            connectionLostToast: 'Conexiune pierdută. Se reîncearcă…', reconnected: 'Reconectat.',
            submitted: 'Trimis.', mustAnswerBeforeSubmit: 'Introdu un răspuns înainte de a trimite.',
            modeAudioToText: 'Audio → Text', modeMorseToText: 'Morse → Text', modeTextToMorse: 'Text → Morse',
            modeCharacterRecognition: 'Recunoaștere caractere', modeTransmission: 'Transmisie Morse',
            formalTest: 'Test formal', groupPractice: 'Practică de grup',
            noOpenSessions: 'Nicio sesiune deschisă momentan. Revino după ce profesorul deschide una.',
            itemsUnit: 'element(e)', loadingSession: 'Se încarcă sesiunea…',
            correctAnswerUnavailable: 'Răspunsul corect nu mai este disponibil.',
            sessionCancelledToast: 'Această sesiune a fost anulată de profesor.', timeUp: 'Timp expirat',
            timesUpNoAnswer: 'Timpul a expirat — niciun răspuns nu a fost înregistrat pentru acest element.',
            play: '▶ Redă', itemAlreadyPlaying: 'Acest element se redă deja pentru clasă — apasă Redă pentru a-l asculta.',
            notReady: 'Nu sunt pregătit', startingIn: 'Începe în {seconds}s', playingStatus: 'Se redă…',
            timeLeft: 'Timp rămas: {seconds}s', keyAtLeastOne: 'Transmite cel puțin un punct sau o liniuță înainte de a trimite.',
            submittedAccuracy: 'Trimis — acuratețe {percent}%.', markLabel: ' Calificativ: {grade}.',
            correctAnswerLabel: ' Răspuns corect: {answer}', answerSubmittedPending: 'Răspuns trimis. Rezultatele vor fi disponibile după terminarea testului.',
            testSubmittedForGrading: 'Testul tău a fost trimis spre evaluare.', niceWorkResults: 'Bună treabă — iată cum ai făcut.',
            noResults: 'Niciun rezultat.', yourAnswerMorseHint: 'Răspunsul tău (Morse: folosește . și - , spațiu între litere)',
            whichCharacterHeard: 'Ce caracter ai auzit?', reconnecting: 'Se reconectează…',
        },
        transmission: {
            holdSpaceHint: 'Ține apăsat <kbd>Space</kbd> pentru a transmite un punct sau o liniuță.',
            settingsSubtitle: 'Alege un set de caractere și setările, apoi transmite tu însuți secvența țintă folosind bara de spațiu.',
            freeTransmission: 'Transmisie liberă', exerciseModeOnly: '(doar în modul exercițiu)',
            timingSettings: 'Setări de temporizare', targetSequence: 'Secvența țintă',
            decodedTransmission: 'Transmisie decodată', transmissionResults: 'Rezultate transmisie',
            timingAnalysis: 'Analiza temporizării', freeTransmissionSubtitle: 'Fără țintă, fără evaluare — transmite orice dorești. Nimic nu este salvat aici.',
            timingStatistics: 'Statistici de temporizare', finishAndGrade: 'Finalizează și evaluează',
            statusReady: 'Pregătit. Ține apăsat Space pentru a începe.', statusWaiting: 'Se așteaptă…',
            statusReadyFree: 'Pregătit — ține apăsat Space pentru a începe.',
            statusTransmittingFree: 'Transmitere liberă — nimic nu este evaluat sau salvat.',
            statusKeyDown: 'Tastă apăsată…',
            targetWpm: 'VPM țintă', totalErrors: 'Total erori', elapsed: 'Timp scurs', rhythmConsistency: 'Consistență ritm',
            avgDotDuration: 'Durată medie punct', avgDashDuration: 'Durată medie liniuță',
            avgCharacterGap: 'Pauză medie între caractere', avgWordGap: 'Pauză medie între grupuri/cuvinte',
            timingErrors: 'Erori de temporizare', totalTransmissionTime: 'Timp total de transmisie',
            holdSpaceHintFull: 'Ține apăsat <kbd>Space</kbd> pentru a transmite un punct sau o liniuță. Eliberează pentru a-l finaliza.',
            fb: {
                dot: { correct: 'Corect', 'too-short': 'Punct prea scurt', 'too-long': 'Punct prea lung' },
                dash: { correct: 'Corect', 'too-short': 'Liniuță prea scurtă', 'too-long': 'Liniuță prea lungă' },
                character: { correct: 'Corect', 'too-short': 'Pauză între caractere prea scurtă', 'too-long': 'Pauză între caractere prea lungă' },
                word: { correct: 'Corect', 'too-short': 'Pauză între grupuri/cuvinte prea scurtă', 'too-long': 'Pauză între grupuri/cuvinte prea lungă' },
                rhythm: { irregular: 'Ritm neregulat' },
            },
        },
        radiogram: {
            comparison: 'Comparație', yourTranscription: 'Transcrierea ta', exerciseSize: 'Dimensiune exercițiu',
            generateAnother: 'Generează altul', newExercise: 'Exercițiu nou',
            settingsSubtitle: 'Alege un set de caractere și setările Morse, apoi generează o radiogramă de copiat.',
            radiogramWord: 'Radiogramă', liveReference: 'Referință live', radiogramResults: 'Rezultate radiogramă',
            analyzeAnswer: 'Analizează răspunsul', generateRadiogram: 'Generează radiograma',
            statusPlaybackComplete: 'Redare finalizată. Termină transcrierea, apoi analizează.',
            statusTransmittingProgress: 'Se transmite… {current} / {total}',
            statusNotStarted: 'Neînceput încă.', statusTransmitting: 'Se transmite…',
            statusStopped: 'Oprit. Poți reda din nou sau analiza ce ai până acum.',
            referenceLabel: 'REFERINȚĂ', yourAnswerLabel: 'RĂSPUNSUL TĂU',
            showRadiogram: 'Arată radiograma', hideRadiogram: 'Ascunde radiograma',
            typeWhatYouHear: 'Scrie ce auzi. Acesta este propriul tău răspuns, separat de referința de mai sus.',
            transcriptionPlaceholder: 'Transcrierea ta va apărea aici pe măsură ce scrii…',
            charactersAppearHint: 'Caracterele apar aici pe măsură ce sunt transmise — nimic nu este afișat în avans.',
            wrong: 'greșit',
        },
        reception: {
            settingsSubtitle: 'Copiere oarbă: niciun text nu este afișat înainte sau în timpul redării. Alege un set și setările, apoi începe.',
            receptionResults: 'Rezultate recepție', submitAndGrade: 'Trimite și evaluează', startExercise: 'Începe exercițiul',
            statusPlaybackComplete: 'Redare finalizată. Termină transcrierea, apoi trimite.',
            statusNotStarted: 'Neînceput încă. Nimic nu este dezvăluit până nu trimiți.',
            statusPaused: 'Pauzat.', statusStopped: 'Oprit. Apasă Start pentru a reda de la început, sau trimite ce ai până acum.',
            statusTransmitting: 'Se transmite…', typeExactlyHint: 'Scrie exact ce auzi. Nimic din ce scrii nu este corectat automat.',
        },
        sessions: {
            pageTitle: '<span class="accent">Sesiuni</span> de grup', pageSubtitle: 'Creează, monitorizează și revizuiește exerciții sincronizate de clasă.',
            stepLabel1: 'Pasul 1 din 4', step1Heading: 'Ce tip de sesiune este aceasta?',
            groupPracticeDesc: 'Neevaluat — elevii primesc feedback imediat.',
            formalTestDesc: 'Evaluat și cronometrat — rezultatele rămân ascunse până la final.',
            stepLabel2: 'Pasul 2 din 4', step2Heading: 'Ce clasă?', loadingClasses: 'Se încarcă clasele…',
            stepLabel3: 'Pasul 3 din 4', step3Heading: 'Alege tipul exercițiului',
            modeAudioToTextDesc: 'Ascultă audio transmis și scrie ce auzi.',
            modeMorseToTextDesc: 'Ascultă codul Morse și transcrie mesajul primit.',
            modeTextToMorseDesc: 'Citește textul și scrie codul Morse corespunzător.',
            modeCharacterRecognitionDesc: 'Identifică fiecare caracter Morse, pe rând.',
            modeTransmissionDesc: 'Citește textul țintă și transmite-l tu cu bara de spațiu.',
            stepLabel4: 'Pasul 4 din 4', step4Heading: 'Configurează exercițiul',
            content: 'Conținut', noPoolSelected: 'Niciun caracter selectat încă — se va folosi setul implicit al dificultății.',
            morse: 'Morse', blankDifficultyDefault: '(gol = valoare implicită a dificultății)', blank600: '(gol = 600)',
            timingTolerance: 'Toleranță temporizare', timingToleranceHint: '(doar Transmisie — mai mare = mai permisiv, gol = 0.35)',
            session: 'Sesiune', itemLength: 'Lungime element (caractere)', numberOfExercises: 'Număr de exerciții',
            instructionsForStudents: 'Instrucțiuni pentru elevi', instructionsHint: '(opțional, afișat în sala de așteptare)',
            instructionsPlaceholder: 'ex. Scrie răspunsul cu majuscule. Vei auzi fiecare element o singură dată.',
            participants: 'Participanți', participantsHint: '(implicit: toată clasa)', selectDeselectAll: 'Selectează/deselectează tot',
            selectClassFirst: 'Selectează o clasă pentru a alege participanții…',
            formalTestSettings: 'Setări test formal', prepTime: 'Timp de pregătire înainte de fiecare element (secunde)',
            answerTime: 'Timp de răspuns per element (secunde)', allowedAttempts: 'Încercări permise per element',
            passThreshold: 'Prag de promovare (% acuratețe, gol = neevaluat)', startGroupSession: 'Începe sesiunea de grup',
            mySessions: 'Sesiunile mele', backToAllSessions: 'Înapoi la toate sesiunile',
            liveConnectionLost: 'Conexiune live pierdută — se reconectează… (lista/progresul pot fi neactualizate)',
            sessionWord: 'Sesiune', exerciseType: 'Tip exercițiu', connected: 'Conectați',
            instructionsShownToStudents: 'Instrucțiuni afișate elevilor:', openForJoining: 'Deschide pentru conectare',
            continueBtn: 'Continuă', cancelSession: 'Anulează sesiunea', liveProgress: 'Progres live',
            roster: 'Listă participanți', rosterHint: 'Se actualizează live pe măsură ce elevii se conectează, se pregătesc sau pleacă.',
            connection: 'Conexiune', ready: 'Pregătit', clickStudentBreakdown: 'Apasă pe un elev pentru a vedea detalierea pe exerciții.',
            student: 'Elev', notFinishedYet: 'Nefinalizat încă.',
            createdToast: 'Sesiune creată.', errSelectCharacters: 'Selectează cel puțin un caracter sau lasă gol pentru setul dificultății.',
            errSelectParticipant: 'Selectează cel puțin un participant.', noSessionsYet: 'Nicio sesiune încă. Creează una mai sus.',
            waitingForStudents: 'Se așteaptă elevii', inProgress: 'În desfășurare', notStarted: 'Neîncepută',
            confirmCancel: 'Anulezi această sesiune? Această acțiune nu poate fi anulată.',
            reconnectedToast: 'Reconectat.', disconnectedToast: 'Conexiune live pierdută.',
            letters: 'Litere', numbers: 'Numere', specialChars: 'Caractere speciale',
            noActiveClasses: 'Nicio clasă activă încă — creează una din Panoul profesorului mai întâi.',
            noActiveStudents: 'Niciun elev activ în această clasă încă.',
            couldNotLoadStudents: 'Nu s-au putut încărca elevii', monitorBtn: 'Monitorizează',
            progressSummary: 'Elementul {current} din {total} — {count} trimitere(i) până acum',
            originalUnavailable: 'Radiogramă originală indisponibilă pentru acest test istoric.',
            correctAnswerCol: 'Răspuns corect', studentAnswerCol: 'Răspuns elev', attempts: 'Încercări',
            pass: 'promovat', fail: 'nepromovat',
            itemStartingShortly: 'Elementul {current} din {total} începe în curând…',
            sessionFinishedToast: 'Sesiune finalizată.', noResultsYet: 'Niciun rezultat încă.',
            difficultyDefault: '(implicit dificultate)', selectedStudentsNote: '{count} elev(i) selectat(i) (nu toată clasa)',
            noStudentsInClass: 'Niciun elev în această clasă încă.', connectedWord: 'Conectat', disconnectedWord: 'Deconectat',
        },
        stats: {
            pageSubtitle: 'Performanță practică/test, pe clasă și pe elev.', classSummary: 'Sumar clasă', exportClassCsv: 'Exportă CSV clasă',
            noDataYet: 'Fără date încă — statisticile apar după ce elevii finalizează exerciții de practică sau teste formale.',
            practiceAttempts: 'Încercări practică', practiceAvgAccuracy: 'Acuratețe medie practică',
            formalTestsCompleted: 'Teste formale finalizate', formalTestAvgScore: 'Scor mediu test formal',
            formalTestPassRate: 'Rată promovare test formal', groupSessionsCompleted: 'Sesiuni de grup finalizate',
            groupSessionAvgScore: 'Scor mediu sesiune de grup', studentBreakdown: 'Detaliere elevi',
            clickStudentProgress: 'Apasă pe un elev pentru a vedea progresul individual.',
            practiceAvg: 'Medie practică', testsTaken: 'Teste susținute', testAvg: 'Medie test', passRate: 'Rată promovare',
            selectClassAbove: 'Selectează o clasă mai sus.', studentProgress: 'Progres elev',
            recentTrend: 'Tendință recentă (ultimele 5)', noRecentActivity: 'Nicio activitate recentă.',
            individualResults: 'Rezultate individuale', exportCsv: 'Exportă CSV', resetHistory: 'Resetează istoricul…',
            direction: 'Direcție', reception: 'Recepție', transmission: 'Transmisie',
            exRadiogramTraining: 'Antrenament radiogramă', exCharacterTraining: 'Antrenament caractere',
            exReceptionAudio: 'Recepție (Audio → Text)', fromDate: 'De la data', toDate: 'Până la data',
            minWpm: 'VPM minim', maxWpm: 'VPM maxim', applyFilters: 'Aplică filtrele', noExercisesMatch: 'Niciun exercițiu nu corespunde acestor filtre.',
            dateTime: 'Data/Ora', actualWpm: 'VPM real', rhythm: 'Ritm', loadMore: 'Încarcă mai multe',
            personalStatistics: 'Statistici personale', totalExercises: 'Total exerciții', averageAccuracy: 'Acuratețe medie',
            bestAccuracy: 'Cea mai bună acuratețe', averageWpm: 'VPM mediu', bestWpm: 'Cel mai bun VPM',
            totalErrors: 'Total erori', receptionAverage: 'Medie recepție', transmissionAverage: 'Medie transmisie',
            noCompletedExercises: 'Niciun exercițiu finalizat încă — exersează ceva în Pregătirea individuală și progresul tău va apărea aici.',
            progressOverTime: 'Progres în timp', last30Days: 'Ultimele 30 de zile', accuracyPercent: 'Acuratețe (%)',
            speedWpm: 'Viteză (VPM)', receptionVsTransmission: 'Recepție vs. Transmisie (acuratețe medie)',
            weakAreas: 'Zone slabe', weakAreasHint: 'Caractere care cauzează probleme repetate (3+ apariții evaluate, sub 80% acuratețe).',
            noWeakCharacters: 'Niciun caracter slab identificat încă — fie nu există suficient istoric, fie nimic nu iese în evidență. Bună treabă.',
            character: 'Caracter', myHistory: 'Istoricul meu',
            weakChars: 'Caractere slabe', confirmResetHistory: 'Resetezi istoricul practicii pentru {name}? Această acțiune nu poate fi anulată.',
            toastHistoryReset: 'Istoric resetat.', toastAttemptDeleted: 'Încercare ștearsă.', confirmDeleteAttempt: 'Ștergi această încercare?',
            noClassesYet: 'Nicio clasă încă', noActiveStudentsInClass: 'Niciun elev activ în această clasă.',
            progressWord: 'Progres', trendText: '{recent} recent vs. {overall} general', notEnoughForTrend: 'Încă nu sunt suficiente încercări pentru o tendință (necesită 10+).',
            showingXofY: 'Se afișează {shown} din {total}', confirmDeleteResult: 'Ștergi definitiv acest rezultat? Această acțiune nu poate fi anulată.',
            resultDeleted: 'Rezultat șters.', confirmResetFiltered: 'Ștergi toate rezultatele de practică ce corespund filtrelor curente pentru acest elev? Această acțiune nu poate fi anulată.',
            confirmResetEntire: 'Ștergi TOT istoricul de practică al acestui elev? Această acțiune nu poate fi anulată.',
            deletedCount: 'Șters(e) {count} rezultat(e).', studentSubtitle: 'Istoricul tău de practică și progresul în timp.',
            noDataYetShort: 'Fără date încă.', noDataShort: 'fără date',
        },
        validation: {
            selectAtLeastOneChar: 'Selectează cel puțin un caracter pentru set.',
            enterValidWpm: 'Introdu o valoare VPM validă.',
            enterValidCharCount: 'Introdu un număr valid de caractere (1 sau mai mult).',
            enterValidGroupCount: 'Introdu un număr valid de grupuri (1 sau mai mult).',
            enterValidTargetWpm: 'Introdu o valoare VPM țintă validă.',
            enterValidCharGroupCount: 'Introdu un număr valid de caractere/grupuri (1 sau mai mult).',
            couldNotLoadCharsets: 'Nu s-au putut încărca seturile de caractere: {message}',
        },
        pool: {
            allLetters: 'Toate literele', allNumbers: 'Toate numerele', allSpecial: 'Toate speciale',
            lettersPlusNumbers: 'Litere + Numere', allCharacters: 'Toate caracterele',
            noneSelected: 'Niciun caracter selectat încă.', morseSettingsHeading: 'Setări Morse', characterPoolHeading: 'Set de caractere',
            charactersSelected: '{count} caracter(e) selectat(e)',
            learnedLettersOnly: 'Doar literele învățate', standardLearningOrder: '(ordinea standard de învățare)',
        },
        hub: {
            subtitle: 'Exersează în ritmul tău. Nu afectează niciodată rezultatele testelor oficiale.',
            radiogramTitle: 'Antrenament radiogramă',
            radiogramDesc: 'Generează o radiogramă completă — 3 rânduri de câte 10 grupuri de 4 caractere — și copiaz-o după ureche pe măsură ce este transmisă.',
            characterTrainingTitle: 'Antrenament caractere',
            characterTrainingDesc: 'Exerciții de recunoaștere a unui singur caracter, cu feedback live după fiecare răspuns.',
            receptionTitle: 'Antrenament recepție',
            receptionDesc: 'Copiere oarbă: ascultă audio Morse și scrie ce auzi, fără nicio referință afișată până la evaluare.',
            transmissionDesc: 'Transmite tu însuți o secvență țintă folosind bara de spațiu — decodare în timp real și feedback de temporizare pe măsură ce transmiți.',
            backToHub: '← Înapoi la Pregătirea individuală',
        },
        characterTraining: {
            settingsSubtitle: 'Ascultă câte un caracter și scrie ce ai auzit. Alege un set de caractere și setările, apoi începe.',
            sessionLength: 'Lungimea sesiunii', numberOfCharacters: 'Număr de caractere',
            visualAid: 'Ajutor vizual', visualMorseAid: 'Ajutor vizual Morse',
            visualMorseAidHint: 'Afișează ritmul Morse și modelul de puncte/liniuțe în timp ce caracterul este redat.',
            startSession: 'Începe sesiunea', sessionResults: 'Rezultatele sesiunii',
            avgResponse: 'Timp mediu de răspuns', fastest: 'Cel mai rapid', slowest: 'Cel mai lent',
            weakCharacters: 'Caractere slabe', weakCharactersHint: 'Caractere sub 80% acuratețe, sau la care ai răspuns constant mai lent decât media sesiunii.',
            noWeakChars: 'Niciun caracter slab în această sesiune — bună treabă!', practiceWeakCharacters: 'Exersează caracterele slabe',
            perCharacterBreakdown: 'Detaliere pe caracter', char: 'Caracter', avgTime: 'Timp mediu',
            practiceAgain: 'Exersează din nou', changeSettings: 'Schimbă setările',
            listenAndType: 'Ascultă, apoi scrie caracterul auzit.', progressText: 'Caracterul {current} / {total}',
        },
        gradebook: {
            title: 'Catalog electronic',
            subtitle: 'Note și observații pentru fiecare elev. Rezultatele testelor formale apar automat ca intrări temporare, până când le salvați permanent.',
            studentsHeading: 'Elevi', searchStudent: 'Caută elev (nume, utilizator, grad)…',
            noStudents: 'Niciun elev găsit.', selectStudentPrompt: 'Selectați un elev din listă pentru a-i deschide catalogul.',
            pendingBadge: '{count} de confirmat', noClass: 'Fără clasă',
            addGrade: 'Adaugă notă', addNote: 'Adaugă observație',
            grade: 'Notă', note: 'Observație', noteOptional: 'Observație (opțional)', gradeHint: 'Notă întreagă, 1–10',
            pendingHeading: 'De confirmat — rezultate test formal',
            pendingHint: 'Create automat la finalul unui test formal. Nu devin note oficiale până nu apăsați „Salvează permanent”.',
            entriesHeading: 'Intrări în catalog', noEntries: 'Nicio intrare salvată încă pentru acest elev.',
            sourceManual: 'Manual', sourceFormalTest: 'Test formal',
            statusTemporary: 'Temporar', statusPermanent: 'Permanent',
            typeGrade: 'Notă', typeNote: 'Observație',
            savePermanently: 'Salvează permanent', edit: 'Editează', delete: 'Șterge', discard: 'Renunță',
            editEntry: 'Editează intrarea', addGradeTitle: 'Adaugă notă — {name}', addNoteTitle: 'Adaugă observație — {name}',
            confirmDelete: 'Ștergeți această intrare? Acțiunea nu poate fi anulată.',
            confirmDiscard: 'Renunțați la această intrare temporară de la testul formal? Nota nu va fi trecută în catalog.',
            confirmPermanent: 'Salvați permanent această notă în catalog? După salvare, nota nu mai poate fi modificată sau ștearsă.',
            toastSaved: 'Intrare salvată.', toastPermanent: 'Salvată permanent în catalog.', toastDeleted: 'Intrare ștearsă.',
            gradeLocked: 'Notă oficială — nu mai poate fi modificată.',
            byTeacher: 'de {name}', updatedAt: 'actualizat {date}',
            testSummary: 'Test #{id} · {mode}', accuracy: 'Acuratețe {value}%', itemsAnswered: '{answered}/{total} itemi',
            pass: 'Promovat', fail: 'Nepromovat', noGrade: 'fără notă',
            gradeInvalid: 'Introduceți o notă întreagă între 1 și 10.', noteRequired: 'Observația nu poate fi goală.',
        },
        alphabet: {
            title: 'Alfabet Morse',
            subtitle: 'Toate caracterele Morse folosite în aplicație — aceleași ca la antrenamente, sesiuni de grup și teste.',
            letters: 'Litere', numbers: 'Numere', special: 'Caractere speciale',
            countChars: '{count} caractere', playHint: 'Apăsați pe un caracter pentru a-l asculta ({wpm} WPM, {hz} Hz).',
            legend: '· = punct (scurt)   − = linie (lungă)', playChar: 'Ascultă {char}',
            loadError: 'Nu s-a putut încărca alfabetul: {message}',
        },
        _end: true,
    };
    const EN = {
        common: {
            start: 'Start', stop: 'Stop', pause: 'Pause', resume: 'Resume',
            restart: 'Restart', finish: 'Finish', submit: 'Submit',
            cancel: 'Cancel', save: 'Save', close: 'Close', clear: 'Clear',
            back: 'Back', next: 'Next', apply: 'Apply', confirm: 'Confirm',
            delete: 'Delete', edit: 'Edit', export: 'Export', print: 'Print',
            loading: 'Loading…', saving: 'Saving…', error: 'Error',
            success: 'Success', yes: 'Yes', no: 'No', ok: 'OK', none: '— none —',
            all: 'All', settings: 'Settings', results: 'Results', progress: 'Progress', done: 'Done',
            correct: 'Correct', incorrect: 'Incorrect', missing: 'Missing', extra: 'Extra',
            accuracy: 'Accuracy', errors: 'Errors', score: 'Score', grade: 'Grade',
            date: 'Date', time: 'Time', duration: 'Duration', total: 'Total',
            average: 'Average', best: 'Best', worst: 'Worst',
            name: 'Name', class: 'Class', status: 'Status', active: 'Active',
            inactive: 'Inactive', reset: 'Reset', refresh: 'Refresh',
            search: 'Search…', volume: 'Volume', tone: 'Tone frequency (Hz)',
            wpm: 'WPM (character speed)', farnsworth: 'Farnsworth WPM', frequency: 'Frequency',
            correct2: 'correct', missing2: 'missing', extra2: 'extra',
            characters: 'characters', of: 'of', confirmDelete: 'Are you sure you want to delete this?',
            unsavedNote: 'Unsaved changes will be lost.', play: 'Play', wpmShort: 'WPM',
            backToSettings: '← Back to settings', backToSettingsShort: 'Change settings',
            resultNotSaved: 'Result could not be saved to your history: {message}',
            groupsUnit: 'groups', farnsworthNote: ' (Farnsworth {wpm} WPM)', targetUnit: 'target',
        },
        nav: {
            home: 'Home', dashboard: 'Dashboard', groupSessions: 'Group Sessions',
            gradebook: 'Electronic Gradebook', morseAlphabet: 'Morse Alphabet',
            statistics: 'Statistics', individualTraining: 'Individual Training',
            logout: 'Log out', themeToLight: 'Switch to light theme',
            themeToDark: 'Switch to dark theme', languageLabel: 'Language',
            switchToRomanian: 'Switch to Romanian', switchToEnglish: 'Switch to English',
        },
        auth: {
            login: 'Log in', username: 'Username', password: 'Password',
            signIn: 'Log in', loggedIn: 'Logged in', signedInAs: 'Signed in as',
            invalidCredentials: 'Invalid username or password.',
            accountDisabled: 'Account disabled.', loginFailed: 'Login failed.',
            couldNotReachServer: 'Could not reach server',
            checkingAccess: 'Checking access…', serverOnline: 'Server Online', serverOnlineUpper: 'Server ONLINE', serverOfflineUpper: 'Server OFFLINE', serverChecking: 'Server …',
            checkingServerStatus: 'Checking server status…',
            shareTitle: 'Share this address with students',
            shareHint: 'Students on the same classroom network open this URL in any web browser.',
            noLan: 'No LAN address detected — check the network connection.',
            myProfile: 'My Profile', rank: 'Rank', profileNote: 'Only your teacher can edit this information or reset your password.',
            openTeacherDashboard: 'Open Teacher Dashboard', startIndividualTraining: 'Start Individual Training',
            joinGroupSession: 'Join a Group Session', noClassAssigned: '— none assigned —',
            roleTeacher: 'teacher', roleStudent: 'student',
            errUsernamePasswordRequired: 'Username and password are required.',
            errTooManyAttempts: 'Too many failed login attempts. Please try again in a few minutes.',
            errAccountDeactivated: 'This account has been deactivated. Contact your teacher.',
        },
        teacher: {
            dashboardTitle: 'Teacher <span class="accent">Dashboard</span>', dashboardSubtitle: 'Manage classes, students, group sessions, and grades.',
            openGroupSessions: 'Open Group Sessions →', searchByClass: 'Search by class…',
            allStatuses: 'All statuses', statusCreated: 'Created', statusWaiting: 'Waiting',
            statusRunning: 'Running', statusPaused: 'Paused', statusFinished: 'Finished', statusCancelled: 'Cancelled',
            type: 'Type', difficulty: 'Difficulty', exercises: 'Exercises', actions: 'Actions',
            studentGrades: 'Student Grades', studentGradesHint: 'Practice + test performance, from the same data as Statistics.',
            searchNameUsername: 'Search name, username…', allClasses: 'All classes',
            username: 'Username', practiceAttempts: 'Practice Attempts', practiceAccuracy: 'Practice Accuracy',
            testSessions: 'Test Sessions', testAvgScore: 'Test Avg Score', testPassRate: 'Test Pass Rate',
            classes: 'Classes', newClass: '+ New Class', students: 'Students', newStudent: '+ New Student',
            searchNameUsernameRank: 'Search name, username, rank…', lastName: 'Last Name', firstName: 'First Name',
            morsePreview: 'Morse Audio Preview', morsePreviewHint: 'Generates and plays audio locally — no network or files involved.',
            text: 'Text', textToConvert: 'Type text to convert to Morse audio…',
            diffBeginner: 'Beginner', diffEasy: 'Easy', diffMedium: 'Medium', diffHard: 'Hard',
            generateRandomText: 'Generate random text', blankSameAsWpm: '(blank = same as WPM)',
            replayPolicy: 'Replay policy', replayPolicyHint: '(demo of future test restrictions)',
            replayUnlimited: 'Unlimited (replay allowed)', replayOnce: 'Play once', replayDisabled: 'Disabled (no play)',
            autoplay: 'Automatic playback (plays as soon as loaded)',
            morseCode: 'Morse code', idle: 'Idle', playCount: 'Play count',
            confirmDeleteClass: 'Delete class "{name}"? Students remain but become unassigned.',
            confirmDeleteStudent: 'Delete student "{name}"? This cannot be undone.',
            confirmResetPassword: 'Reset the password for "{name}"?',
            noClassesYet: 'No classes yet. Create one to get started.',
            reassignBeforeDelete: 'Reassign or remove students before deleting.',
            rename: 'Rename', deactivate: 'Deactivate', reactivate: 'Reactivate', resetPw: 'Reset PW',
            newClassModalTitle: 'New Class', className: 'Class name', classNamePlaceholder: 'e.g. Radio Comms 101', create: 'Create',
            errClassNameRequired: 'Class name is required.', toastClassCreated: 'Class created.',
            renameModalTitle: 'Rename "{name}"', toastClassRenamed: 'Class renamed.',
            toastClassDeactivated: 'Class deactivated.', toastClassReactivated: 'Class reactivated.',
            deleteClassModalTitle: 'Delete "{name}"?', deleteClassNote: 'This permanently removes the class. This cannot be undone.',
            toastClassDeleted: 'Class deleted.', noStudentsMatch: 'No students match the current filters.',
            newStudentModalTitle: 'New Student', tempPassword: 'Temporary password', tempPasswordPlaceholder: 'At least 8 characters',
            noClass: '— No class —', errUsernameRequired: 'Username is required.',
            errPasswordLength: 'Password must be at least 8 characters.', toastStudentCreated: 'Student created.',
            editStudentModalTitle: 'Edit Student', toastStudentUpdated: 'Student updated.',
            toastStudentDeactivated: 'Student deactivated.', toastStudentReactivated: 'Student reactivated.',
            resetPasswordTitle: 'Reset password for {username}',
            resetPasswordNote: 'A new random password will be generated and shown once below. Any sessions this student has open will be signed out.',
            generateNewPassword: 'Generate new password',
            writeDownPassword: 'Write this down now — it will not be shown again. Click Cancel to close.',
            toastPasswordReset: 'Password reset.', noSessionsMatch: 'No group sessions match the current filters.',
            open: 'Open', somethingWrong: 'Something went wrong.',
            playing: 'Playing…', finished: 'Finished', stopped: 'Stopped', replayBlocked: 'Replay blocked by current policy',
            ready: 'Ready', emptyParens: '(empty)', unsupportedCharsSkipped: 'Unsupported character(s) skipped: {chars}',
            enterTextFirst: 'Enter some text first.',
        },
        groupSession: {
            connectionLost: 'Connection lost — reconnecting…',
            title: '<span class="accent">Group</span> Sessions', subtitle: 'Sessions your teacher has opened for your class.',
            noClassNotice: 'You are not assigned to a class yet — ask your teacher to assign you one.',
            waitingRoom: 'Waiting Room', waiting: 'waiting', instructions: 'Instructions:',
            imReady: "I'm Ready", readyHint: 'Clicking "I\'m Ready" also unlocks audio playback in this browser — required once per session by your browser\'s autoplay rules.',
            leaveSession: 'Leave this session', getReady: 'Get ready…', replay: 'Replay',
            yourAnswer: 'Your answer', sessionComplete: 'Session Complete', greatWork: 'Great work.',
            item: 'Item', answer: 'Answer', mark: 'Mark', backToSessions: 'Back to Sessions',
            itemProgress: 'Item {current} of {total}', noSessionsAvailable: 'No sessions currently available for your class.',
            joinSession: 'Join', sessionStatusCreated: 'created', sessionStatusWaiting: 'waiting',
            sessionStatusRunning: 'running', sessionStatusPaused: 'paused', sessionStatusFinished: 'finished', sessionStatusCancelled: 'cancelled',
            waitingForTeacher: 'Waiting for the teacher to start the session.',
            readyCount: '{ready} ready · {connected} connected of {total}', couldNotJoin: 'Could not join the session.',
            sessionPaused: 'The session has been paused by the teacher.', sessionCancelled: 'The session was cancelled by the teacher.',
            connectionLostToast: 'Connection lost. Retrying…', reconnected: 'Reconnected.',
            submitted: 'Submitted.', mustAnswerBeforeSubmit: 'Enter an answer before submitting.',
            modeAudioToText: 'Audio → Text', modeMorseToText: 'Morse → Text', modeTextToMorse: 'Text → Morse',
            modeCharacterRecognition: 'Character Recognition', modeTransmission: 'Morse Transmission',
            formalTest: 'Formal Test', groupPractice: 'Group Practice',
            noOpenSessions: 'No open sessions right now. Check back once your teacher opens one.',
            itemsUnit: 'item(s)', loadingSession: 'Loading session…',
            correctAnswerUnavailable: 'Correct answer is no longer available.',
            sessionCancelledToast: 'This session was cancelled by your teacher.', timeUp: 'Time up',
            timesUpNoAnswer: "Time's up — no answer was recorded for this item.",
            play: '▶ Play', itemAlreadyPlaying: 'This item is already playing for the class — press Play to hear it.',
            notReady: 'Not Ready', startingIn: 'Starting in {seconds}s', playingStatus: 'Playing…',
            timeLeft: 'Time left: {seconds}s', keyAtLeastOne: 'Key at least one dot or dash before submitting.',
            submittedAccuracy: 'Submitted — accuracy {percent}%.', markLabel: ' Mark: {grade}.',
            correctAnswerLabel: ' Correct answer: {answer}', answerSubmittedPending: 'Answer submitted. Results will be available once the test ends.',
            testSubmittedForGrading: 'Your test has been submitted for grading.', niceWorkResults: 'Nice work — here is how you did.',
            noResults: 'No results.', yourAnswerMorseHint: 'Your answer (Morse: use . and - , space between letters)',
            whichCharacterHeard: 'Which character did you hear?', reconnecting: 'Reconnecting…',
        },
        transmission: {
            holdSpaceHint: 'Hold <kbd>Space</kbd> to key a dot or dash.',
            settingsSubtitle: 'Choose a character pool and settings, then key the target sequence yourself using the Space bar.',
            freeTransmission: 'Free Transmission', exerciseModeOnly: '(Exercise mode only)',
            timingSettings: 'Timing settings', targetSequence: 'Target sequence',
            decodedTransmission: 'Decoded transmission', transmissionResults: 'Transmission Results',
            timingAnalysis: 'Timing analysis', freeTransmissionSubtitle: 'No target, no grading — key anything you like. Nothing here is saved.',
            timingStatistics: 'Timing statistics', finishAndGrade: 'Finish & Grade',
            statusReady: 'Ready. Hold Space to begin.', statusWaiting: 'Waiting…',
            statusReadyFree: 'Ready — hold Space to begin.',
            statusTransmittingFree: 'Transmitting freely — nothing is graded or saved.',
            statusKeyDown: 'Key down…',
            targetWpm: 'Target WPM', totalErrors: 'Total errors', elapsed: 'Elapsed', rhythmConsistency: 'Rhythm consistency',
            avgDotDuration: 'Average dot duration', avgDashDuration: 'Average dash duration',
            avgCharacterGap: 'Average character gap', avgWordGap: 'Average group/word gap',
            timingErrors: 'Timing errors', totalTransmissionTime: 'Total transmission time',
            holdSpaceHintFull: 'Hold <kbd>Space</kbd> to key a dot or dash. Release to complete it.',
            fb: {
                dot: { correct: 'Correct', 'too-short': 'Dot too short', 'too-long': 'Dot too long' },
                dash: { correct: 'Correct', 'too-short': 'Dash too short', 'too-long': 'Dash too long' },
                character: { correct: 'Correct', 'too-short': 'Character gap too short', 'too-long': 'Character gap too long' },
                word: { correct: 'Correct', 'too-short': 'Group/word gap too short', 'too-long': 'Group/word gap too long' },
                rhythm: { irregular: 'Irregular rhythm' },
            },
        },
        radiogram: {
            comparison: 'Comparison', yourTranscription: 'Your transcription', exerciseSize: 'Exercise size',
            generateAnother: 'Generate Another', newExercise: 'New Exercise',
            settingsSubtitle: 'Choose a character pool and Morse settings, then generate a radiogram to copy.',
            radiogramWord: 'Radiogram', liveReference: 'Live reference', radiogramResults: 'Radiogram Results',
            analyzeAnswer: 'Analyze Answer', generateRadiogram: 'Generate Radiogram',
            statusPlaybackComplete: 'Playback complete. Finish your transcription, then analyze.',
            statusTransmittingProgress: 'Transmitting… {current} / {total}',
            statusNotStarted: 'Not started yet.', statusTransmitting: 'Transmitting…',
            statusStopped: 'Stopped. You can replay, or analyze what you have so far.',
            referenceLabel: 'REFERENCE', yourAnswerLabel: 'YOUR ANSWER',
            showRadiogram: 'Show Radiogram', hideRadiogram: 'Hide Radiogram',
            typeWhatYouHear: 'Type what you hear. This is your own answer, kept separate from the reference above.',
            transcriptionPlaceholder: 'Your transcription will appear here as you type…',
            charactersAppearHint: "Characters appear here as they're transmitted — nothing is shown in advance.",
            wrong: 'wrong',
        },
        reception: {
            settingsSubtitle: 'Blind copy: no text is shown before or during playback. Choose a pool and settings, then start.',
            receptionResults: 'Reception Results', submitAndGrade: 'Submit & Grade', startExercise: 'Start Exercise',
            statusPlaybackComplete: 'Playback complete. Finish your transcription, then submit.',
            statusNotStarted: 'Not started yet. Nothing is revealed until you submit.',
            statusPaused: 'Paused.', statusStopped: 'Stopped. Press Start to play from the beginning, or submit what you have so far.',
            statusTransmitting: 'Transmitting…', typeExactlyHint: 'Type exactly what you hear. Nothing you type is auto-corrected.',
        },
        sessions: {
            pageTitle: '<span class="accent">Group</span> Sessions', pageSubtitle: 'Create, monitor, and review synchronized class exercises.',
            stepLabel1: 'Step 1 of 4', step1Heading: 'What kind of session is this?',
            groupPracticeDesc: 'Ungraded — students get feedback right away.',
            formalTestDesc: 'Graded & timed — results stay hidden until it ends.',
            stepLabel2: 'Step 2 of 4', step2Heading: 'Which class?', loadingClasses: 'Loading classes…',
            stepLabel3: 'Step 3 of 4', step3Heading: 'Choose the exercise type',
            modeAudioToTextDesc: 'Listen to the transmitted audio and type what you hear.',
            modeMorseToTextDesc: 'Listen to Morse code and transcribe the received message.',
            modeTextToMorseDesc: 'Read the text and type the matching Morse code.',
            modeCharacterRecognitionDesc: 'Identify individual Morse characters, one at a time.',
            modeTransmissionDesc: 'Read the target text and key it yourself with the Space bar.',
            stepLabel4: 'Step 4 of 4', step4Heading: 'Configure the exercise',
            content: 'Content', noPoolSelected: "No characters selected yet — the difficulty preset's own pool will be used.",
            morse: 'Morse', blankDifficultyDefault: '(blank = difficulty default)', blank600: '(blank = 600)',
            timingTolerance: 'Timing tolerance', timingToleranceHint: '(Transmission only — higher = more forgiving, blank = 0.35)',
            session: 'Session', itemLength: 'Item length (characters)', numberOfExercises: 'Number of exercises',
            instructionsForStudents: 'Instructions for students', instructionsHint: '(optional, shown in the waiting room)',
            instructionsPlaceholder: 'e.g. Type your answer in capital letters. You will hear each item once.',
            participants: 'Participants', participantsHint: '(default: everyone in the class)', selectDeselectAll: 'Select/deselect all',
            selectClassFirst: 'Select a class to choose participants…',
            formalTestSettings: 'Formal Test Settings', prepTime: 'Preparation time before each item (seconds)',
            answerTime: 'Answer time per item (seconds)', allowedAttempts: 'Allowed attempts per item',
            passThreshold: 'Pass threshold (% accuracy, blank = ungraded)', startGroupSession: 'Start Group Session',
            mySessions: 'My Sessions', backToAllSessions: 'Back to all sessions',
            liveConnectionLost: 'Live connection lost — reconnecting… (roster/progress may be stale)',
            sessionWord: 'Session', exerciseType: 'Exercise type', connected: 'Connected',
            instructionsShownToStudents: 'Instructions shown to students:', openForJoining: 'Open for Joining',
            continueBtn: 'Continue', cancelSession: 'Cancel Session', liveProgress: 'Live Progress',
            roster: 'Roster', rosterHint: 'Updates live as students join, ready up, or leave.',
            connection: 'Connection', ready: 'Ready', clickStudentBreakdown: 'Click a student to see their per-exercise breakdown.',
            student: 'Student', notFinishedYet: 'Not finished yet.',
            createdToast: 'Session created.', errSelectCharacters: 'Select at least one character, or leave blank for the difficulty pool.',
            errSelectParticipant: 'Select at least one participant.', noSessionsYet: 'No sessions yet. Create one above.',
            waitingForStudents: 'Waiting for students', inProgress: 'In progress', notStarted: 'Not started',
            confirmCancel: 'Cancel this session? This cannot be undone.',
            reconnectedToast: 'Reconnected.', disconnectedToast: 'Live connection lost.',
            letters: 'Letters', numbers: 'Numbers', specialChars: 'Special characters',
            noActiveClasses: 'No active classes yet — create one from the Dashboard first.',
            noActiveStudents: 'No active students in this class yet.',
            couldNotLoadStudents: 'Could not load students', monitorBtn: 'Monitor',
            progressSummary: 'Item {current} of {total} — {count} submission(s) so far',
            originalUnavailable: 'Original radiogram unavailable for this historical test.',
            correctAnswerCol: 'Correct Answer', studentAnswerCol: 'Student Answer', attempts: 'Attempts',
            pass: 'pass', fail: 'fail',
            itemStartingShortly: 'Item {current} of {total} starting shortly…',
            sessionFinishedToast: 'Session finished.', noResultsYet: 'No results yet.',
            difficultyDefault: '(difficulty default)', selectedStudentsNote: '{count} selected student(s) (not the whole class)',
            noStudentsInClass: 'No students in this class yet.', connectedWord: 'Connected', disconnectedWord: 'Disconnected',
        },
        stats: {
            pageSubtitle: 'Class-wide and per-student practice/test performance.', classSummary: 'Class Summary', exportClassCsv: 'Export Class CSV',
            noDataYet: 'No data yet — statistics appear once students complete practice exercises or formal tests.',
            practiceAttempts: 'Practice attempts', practiceAvgAccuracy: 'Practice avg. accuracy',
            formalTestsCompleted: 'Formal tests completed', formalTestAvgScore: 'Formal test avg. score',
            formalTestPassRate: 'Formal test pass rate', groupSessionsCompleted: 'Group sessions completed',
            groupSessionAvgScore: 'Group session avg. score', studentBreakdown: 'Student Breakdown',
            clickStudentProgress: 'Click a student to see their individual progress.',
            practiceAvg: 'Practice Avg.', testsTaken: 'Tests Taken', testAvg: 'Test Avg.', passRate: 'Pass Rate',
            selectClassAbove: 'Select a class above.', studentProgress: 'Student Progress',
            recentTrend: 'Recent trend (last 5)', noRecentActivity: 'No recent activity.',
            individualResults: 'Individual Results', exportCsv: 'Export CSV', resetHistory: 'Reset History…',
            direction: 'Direction', reception: 'Reception', transmission: 'Transmission',
            exRadiogramTraining: 'Radiogram Training', exCharacterTraining: 'Character Training',
            exReceptionAudio: 'Reception (Audio → Text)', fromDate: 'From date', toDate: 'To date',
            minWpm: 'Min WPM', maxWpm: 'Max WPM', applyFilters: 'Apply Filters', noExercisesMatch: 'No exercises match these filters.',
            dateTime: 'Date/Time', actualWpm: 'Actual WPM', rhythm: 'Rhythm', loadMore: 'Load more',
            personalStatistics: 'Personal Statistics', totalExercises: 'Total exercises', averageAccuracy: 'Average accuracy',
            bestAccuracy: 'Best accuracy', averageWpm: 'Average WPM', bestWpm: 'Best WPM',
            totalErrors: 'Total errors', receptionAverage: 'Reception average', transmissionAverage: 'Transmission average',
            noCompletedExercises: 'No completed exercises yet — practice something in Individual Training and your progress will appear here.',
            progressOverTime: 'Progress Over Time', last30Days: 'Last 30 days', accuracyPercent: 'Accuracy (%)',
            speedWpm: 'Speed (WPM)', receptionVsTransmission: 'Reception vs. Transmission (avg. accuracy)',
            weakAreas: 'Weak Areas', weakAreasHint: 'Characters that repeatedly cause problems (3+ scored occurrences, below 80% accuracy).',
            noWeakCharacters: "No weak characters identified yet — either there isn't enough history, or nothing stands out. Nice work.",
            character: 'Character', myHistory: 'My History',
            weakChars: 'Weak characters', confirmResetHistory: "Reset {name}'s practice history? This cannot be undone.",
            toastHistoryReset: 'History reset.', toastAttemptDeleted: 'Attempt deleted.', confirmDeleteAttempt: 'Delete this attempt?',
            noClassesYet: 'No classes yet', noActiveStudentsInClass: 'No active students in this class.',
            progressWord: 'Progress', trendText: '{recent} recent vs. {overall} overall', notEnoughForTrend: 'Not enough attempts yet for a trend (needs 10+).',
            showingXofY: 'Showing {shown} of {total}', confirmDeleteResult: 'Delete this result permanently? This cannot be undone.',
            resultDeleted: 'Result deleted.', confirmResetFiltered: 'Delete every practice result matching the current filters for this student? This cannot be undone.',
            confirmResetEntire: "Delete this student's ENTIRE practice history? This cannot be undone.",
            deletedCount: 'Deleted {count} result(s).', studentSubtitle: 'Your own practice history and progress over time.',
            noDataYetShort: 'No data yet.', noDataShort: 'no data',
        },
        validation: {
            selectAtLeastOneChar: 'Select at least one character for the pool.',
            enterValidWpm: 'Enter a valid WPM.',
            enterValidCharCount: 'Enter a valid number of characters (1 or more).',
            enterValidGroupCount: 'Enter a valid number of groups (1 or more).',
            enterValidTargetWpm: 'Enter a valid target WPM.',
            enterValidCharGroupCount: 'Enter a valid number of characters/groups (1 or more).',
            couldNotLoadCharsets: 'Could not load character sets: {message}',
        },
        pool: {
            allLetters: 'All Letters', allNumbers: 'All Numbers', allSpecial: 'All Special',
            lettersPlusNumbers: 'Letters + Numbers', allCharacters: 'All Characters',
            noneSelected: 'No characters selected yet.', morseSettingsHeading: 'Morse settings', characterPoolHeading: 'Character pool',
            charactersSelected: '{count} character(s) selected',
            learnedLettersOnly: 'Learned letters only', standardLearningOrder: '(standard learning order)',
        },
        hub: {
            subtitle: 'Practice at your own pace. This never affects official test results.',
            radiogramTitle: 'Radiogram Training',
            radiogramDesc: "Generate a full radiogram — 3 rows of 10 four-character groups — and copy it by ear as it's transmitted.",
            characterTrainingTitle: 'Character Training',
            characterTrainingDesc: 'Single-character recognition drills with live feedback after every answer.',
            receptionTitle: 'Reception Training',
            receptionDesc: "Blind copy: listen to Morse audio and type what you hear, with no reference shown until you're graded.",
            transmissionDesc: 'Key a target sequence yourself using the Space bar — real-time decoding and timing feedback as you send.',
            backToHub: '← Back to Individual Training',
        },
        characterTraining: {
            settingsSubtitle: 'Listen to one character at a time and type what you heard. Choose a pool and settings, then start.',
            sessionLength: 'Session length', numberOfCharacters: 'Number of characters',
            visualAid: 'Visual aid', visualMorseAid: 'Visual Morse Aid',
            visualMorseAidHint: 'Show the Morse rhythm and dot/dash pattern while the character is being played.',
            startSession: 'Start Session', sessionResults: 'Session Results',
            avgResponse: 'Avg. response', fastest: 'Fastest', slowest: 'Slowest',
            weakCharacters: 'Weak characters', weakCharactersHint: 'Characters below 80% accuracy, or answered consistently slower than the session average.',
            noWeakChars: 'No weak characters this session — nice work!', practiceWeakCharacters: 'Practice Weak Characters',
            perCharacterBreakdown: 'Per-character breakdown', char: 'Char', avgTime: 'Avg. time',
            practiceAgain: 'Practice Again', changeSettings: 'Change settings',
            listenAndType: 'Listen, then type the character you heard.', progressText: 'Character {current} / {total}',
        },
        gradebook: {
            title: 'Electronic Gradebook',
            subtitle: 'Grades and notes for each student. Formal Test results appear automatically as temporary entries until you save them permanently.',
            studentsHeading: 'Students', searchStudent: 'Search student (name, username, rank)…',
            noStudents: 'No students found.', selectStudentPrompt: 'Select a student from the list to open their gradebook.',
            pendingBadge: '{count} to confirm', noClass: 'No class',
            addGrade: 'Add grade', addNote: 'Add note',
            grade: 'Grade', note: 'Note', noteOptional: 'Note (optional)', gradeHint: 'Whole number, 1–10',
            pendingHeading: 'To confirm — Formal Test results',
            pendingHint: 'Created automatically when a Formal Test ends. They do not become official grades until you click "Save permanently".',
            entriesHeading: 'Gradebook entries', noEntries: 'No saved entries for this student yet.',
            sourceManual: 'Manual', sourceFormalTest: 'Formal Test',
            statusTemporary: 'Temporary', statusPermanent: 'Permanent',
            typeGrade: 'Grade', typeNote: 'Note',
            savePermanently: 'Save permanently', edit: 'Edit', delete: 'Delete', discard: 'Discard',
            editEntry: 'Edit entry', addGradeTitle: 'Add grade — {name}', addNoteTitle: 'Add note — {name}',
            confirmDelete: 'Delete this entry? This cannot be undone.',
            confirmDiscard: 'Discard this temporary Formal Test entry? The grade will not be recorded in the gradebook.',
            confirmPermanent: 'Save this grade permanently in the gradebook? Once saved it can no longer be changed or deleted.',
            toastSaved: 'Entry saved.', toastPermanent: 'Saved permanently in the gradebook.', toastDeleted: 'Entry deleted.',
            gradeLocked: 'Official grade — can no longer be changed.',
            byTeacher: 'by {name}', updatedAt: 'updated {date}',
            testSummary: 'Test #{id} · {mode}', accuracy: 'Accuracy {value}%', itemsAnswered: '{answered}/{total} items',
            pass: 'Pass', fail: 'Fail', noGrade: 'no grade',
            gradeInvalid: 'Enter a whole-number grade from 1 to 10.', noteRequired: 'A note cannot be empty.',
        },
        alphabet: {
            title: 'Morse Alphabet',
            subtitle: 'Every Morse character used by the application — the same ones used in training, group sessions and tests.',
            letters: 'Letters', numbers: 'Numbers', special: 'Special Characters',
            countChars: '{count} characters', playHint: 'Click a character to hear it ({wpm} WPM, {hz} Hz).',
            legend: '· = dot (short)   − = dash (long)', playChar: 'Play {char}',
            loadError: 'Could not load the alphabet: {message}',
        },
        _end: true,
    };
    const DICTS = { ro: RO, en: EN };

    window.I18N = {
        t,
        setLanguage,
        getLanguage: currentLanguage,
        applyTranslations,
        SUPPORTED_LANGS,
        DEFAULT_LANG,
    };
    window.t = t;
})();
