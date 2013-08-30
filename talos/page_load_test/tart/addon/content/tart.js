// TODO:
// V - Read transition duration from style instead of hardcoded 250ms (mconley)
// V - Remove caret from tart.html (unfocus url bar)
// V - Add fade-only tests (added icon @DPI2/current, simple @dpi current, lastTab @current. only icon@dpi2 runs on talos by default)
// V - Output JSON results (OK to log, check with MattN if that's enough)
// V - UI: Add tests descriptions, button to deselect all, Notice about profiling and Accurate 1st frame, copy JSON to clipboard.
// V - Add profiler markers as start/done:[test-name]
// V - Add custom subtests for talos by URL (tart.html)
// V - Change repeat order from column to row major
//     (now repeats each test N times then advances to next test - instead of repeating the entire set N times)
// V - Objectify
// V - make sure of window size (use pinned tart tab - enough even in scale 2 with australis)
// V - Make sure test-cases work on australis (min tab width for 8th tab)
// V - pref - disable paint starvation: docshell.event_starvation_delay_hint=1 -> will be set by talos or by the user
// V - For manual test: display: relevent prefs instructions (rate, starve hint), instructions for many-tabs
// V - allow API-less intervals recording (using rAF, since the API is b0rked with OMTC)
//     (but using rAF appears to record spurious very short intervals which I think are not really frames)
// V - Optimize cases (minimize test count without hurting cover):
//     - v1: only single tab, open + close, DPI1: about:blank, with-icon-and-long-title. DPI2: only the icon case
// V - Log output
// X - Support scroll into view (no end event)
// X - have preview images: hard to make work across versions
// - Tests:
//   V - With favicon
//   V - Different DPIs
//   V - with fade only (no tab open/close overhead)
//   X - tab drag
//   X - tab remove from the middle
//   X - Without add-tab button -> can be hidden while testing manually. in talos always with the button
function Tart() {
}

Tart.prototype = {
  clickNewTab: function() {
    this._win.BrowserOpenTab();
    // Modifying the style for each tab right after opening seems like it could regress performance,
    // However, overlaying a global style over browser.xul actually ends up having greater ovrehead,
    // especially while closing the last of many tabs (a noticeable ~250ms delay before expanding the rest).
    // To overlay the style globally, add at tart/chrome.manifest:
    // style chrome://browser/content/browser.xul chrome://tart/content/tab-min-width-1px.css
    // where the file tab-min-width-1px.css is:
    // .tabbrowser-tab[fadein]:not([pinned]) { min-width: 1px !important; }
    // Additionally, the global style overlay apparently messes with intervals recording when layout.frame_rate=10000:
    // Using the startFrameTimeRecording API, the first interval appears extra long (~1000ms) even with much widget tickling,
    // Per-tab min-width on open it is then.

    // --> many-tabs case which requires modified max-width will not go into v1. No need for now.
    //this._win.gBrowser.selectedTab.style.minWidth = "1px"; // Prevent overflow regrdless of DPI scale.

    return this._win.gBrowser.selectedTab;
  },

  clickCloseCurrentTab: function() {
    this._win.BrowserCloseTabOrWindow();
    return this._win.gBrowser.selectedTab;
  },

  fadeOutCurrentTab: function() {
    this._win.gBrowser.selectedTab.removeAttribute("fadein");
  },

  fadeInCurrentTab: function() {
    this._win.gBrowser.selectedTab.setAttribute("fadein", "true");
  },

  pinTart: function() {
    return this._win.gBrowser.pinTab(this._tartTab);
  },

  unpinTart: function() {
    return this._win.gBrowser.unpinTab(this._tartTab);
  },

  USE_RECORDING_API: true, // true for Start[/Stop]FrameTimeRecording, otherwise record using rAF - which will also work with OMTC
                           // but (currently) also records iterations without paint invalidations

  _win: undefined,
  _tartTab: undefined,
  _results: [],
  _config: {subtests: [], repeat: 1, rest: 500, tickle: true},

  _animate: function(preWaitMs, triggerFunc, onDoneCallback, isReportResult, name, referenceDuration) {
    var self = this;
    var recordingHandle;
    var timeoutId = 0;
    var listnerObject;
    var rAF = window.requestAnimationFrame || window.mozRequestAnimationFrame;
    const Ci = Components.interfaces;
    const Cc = Components.classes;

    var addMarker = function dummyMarker(str){};
    try { addMarker = Cc["@mozilla.org/tools/profiler;1"].getService(Ci.nsIProfiler).AddMarker; }
    catch (e) {};

    var _recording = [];
    var _abortRecording = false;
    function startRecord() {
      addMarker("start:" + (isReportResult ? name : "[warmup]"));
      if (self.USE_RECORDING_API) {
        return window.QueryInterface(Ci.nsIInterfaceRequestor)
                     .getInterface(Ci.nsIDOMWindowUtils)
                     .startFrameTimeRecording();
      }

      _recording = [];
      _abortRecording = false;

      var last = performance.now();
      function rec() {
        //self._win.getComputedStyle(self._win.gBrowser.selectedTab).width; // force draw - not good - too much regression
        if (_abortRecording) return;

        var now = performance.now();
        _recording.push(now - last);
        last = now;
        rAF(rec);
      }

      rAF(rec);

      return 1; // dummy
    }

    function stopRecord(Handle) {
      addMarker("done:" + (isReportResult ? name : "[warmup]"));
      if (self.USE_RECORDING_API) {
        var paints = {};
        return window.QueryInterface(Ci.nsIInterfaceRequestor)
                     .getInterface(Ci.nsIDOMWindowUtils)
                     .stopFrameTimeRecording(recordingHandle, paints);

      }

      _abortRecording = true;
      return _recording.slice(0); // clone
    }


    function addResult(intervals) {
      // For each animation sequence (intervals) we report 3 values:
      // 1. Average interval for the last 50% of the reference duration
      //    (e.g. if the reference duration is 250ms then average of the last 125ms,
      //     regardless of the actual animation duration in practice)
      // 2. Average interval for the entire animation.
      // 3. Absolute difference between reference duration to actual diration.

      var sumLastHalf = 0;
      var countLastHalf = 0;
      var sumMost = 0;
      var countMost = 0;
      var sum = 0;
      for (var i = intervals.length - 1; i >= 0; i--) {
        sum += intervals[i];
        if (sumLastHalf < referenceDuration / 2) {
          sumLastHalf += intervals[i];
          countLastHalf++;
        }
        if (sumMost < referenceDuration * .85) {
          sumMost += intervals[i];
          countMost++;
        }
      }

      var averageLastHalf = countLastHalf ? sumLastHalf / countLastHalf : 0;
      var averageMost    = countMost ? sumMost / countMost : 0;
      var averageOverall = intervals.length ? sum / intervals.length : 0;
      var durationDiff = Math.abs(sum - referenceDuration);

      self._results.push({name: name + ".raw.TART",   value: intervals}); // Just for display if running manually - Not collected for talos.
      self._results.push({name: name + ".half.TART",  value: averageLastHalf});
 //     self._results.push({name: name + ".most.TART",  value: averageMost});
      self._results.push({name: name + ".all.TART",   value: averageOverall});
 //     self._results.push({name: name + ".sum.TART",   value: sum});
      self._results.push({name: name + ".error.TART", value: durationDiff});
    }

    function transEnd(e) {
      if (e && e.propertyName!="max-width") { // If it's an event (and not a timeout) then only max-width indicates end of animation.
        return;
      }
      // First cancel any further end-events for this animation.
      clearTimeout(timeoutId);
      listnerObject.removeEventListener("transitionend", transEnd);

      // Get the recorded frame intervals and append result if required
      let intervals = stopRecord(recordingHandle);
      if (isReportResult) {
        addResult(intervals);
      }

      onDoneCallback();
    }

    function trigger(f) {
      if (!self.USE_RECORDING_API)
        return rAF(f);

      // When using the recording API, the first interval is to last frame, which could have been a while ago.
      // To make sure the first interval is counted correctly, we "tickle" a widget
      // and immidiatly afterwards start the test, such the last frame timestamp prior to the recording is now.
      // However, on some systems, modifying the widget once isn't always enough, hence the tickle loop.
      //
      var id = "back-button";
      var orig = self._win.document.getElementById(id).style.opacity;
      var i = 0;

      function tickleLoop() {
        if (i++ < ((isReportResult && self._config.tickle) ? 17 : 0)) {
          self._win.document.getElementById(id).style.opacity = i%10 /10 + .05; // just some style modification which will force redraw
          return rAF(tickleLoop);
        }

        self._win.document.getElementById(id).style.opacity = orig;
        return rAF(f);
      }

      tickleLoop();

    }


    setTimeout(function() {
      trigger(function() {
        timeoutId = setTimeout(transEnd, 1000);
        recordingHandle = startRecord();
        triggerFunc();
        // Listen to tabstrip instead of tab because when closing a tab, the listener ends up on an inactive tab,
        // thus throttled timers -> inaccurate (possibly late) finish event timing
        (listnerObject = self._win.gBrowser.tabContainer).addEventListener("transitionend", transEnd);
      });
    }, preWaitMs);

  },


  _nextCommandIx: 0,
  _commands: [],
  _onSequenceComplete: 0,
  _nextCommand: function() {
    if (this._nextCommandIx >= this._commands.length) {
      this._onSequenceComplete();
      return;
    }
    this._commands[this._nextCommandIx++]();
  },
  // Each command at the array a function which must call nextCommand once it's done
  _doSequence: function(commands, onComplete) {
    this._commands = commands;
    this._onSequenceComplete = onComplete;
    this._results = [];
    this._nextCommandIx = 0;

    this._nextCommand();
  },

  _log: function(str) {
    if (window.MozillaFileLogger && window.MozillaFileLogger.log)
      window.MozillaFileLogger.log(str);

    window.dump(str);
  },

  _logLine: function(str) {
    return this._log(str + "\n");
  },

  _reportAllResults: function() {
    var testNames = [];
    var testResults = [];

    var out = "";
    for (var i in this._results) {
      res = this._results[i];
      var disp = [].concat(res.value).map(function(a){return (isNaN(a) ? -1 : a.toFixed(1));}).join(" ");
      out += res.name + ": " + disp + "\n";

      if (!Array.isArray(res.value)) { // raw intervals array is not reported to talos
        testNames.push(res.name);
        testResults.push(res.value);
      }
    }
    this._log("\n" + out);

    if (content && content.tpRecordTime) {
      content.tpRecordTime(testResults.join(','), 0, testNames.join(','));
    } else {
      //alert(out);
    }
  },

  _onTestComplete: null,

  _doneInternal: function() {
    this._logLine("TART_RESULTS_JSON=" + JSON.stringify(this._results));
    this._reportAllResults();
    this._win.gBrowser.selectedTab = this._tartTab;

    if (this._onTestComplete) {
      this._onTestComplete(JSON.parse(JSON.stringify(this._results))); // clone results
    }
  },

  _startTest: function() {

    // Save prefs and states which will change during the test, to get restored when done.
    var origNewtabUrl =     Services.prefs.getCharPref("browser.newtab.url");
    var origNewtabEnabled = Services.prefs.getBoolPref("browser.newtabpage.enabled");
    var origPreload =       Services.prefs.getBoolPref("browser.newtab.preload");
    var origDpi =           Services.prefs.getCharPref("layout.css.devPixelsPerPx");
    var origPinned =        this._tartTab.pinned;

    var self = this;
    var animate = this._animate.bind(this);
    var addTab = this.clickNewTab.bind(this);
    var closeCurrentTab = this.clickCloseCurrentTab.bind(this);
    var fadein = this.fadeInCurrentTab.bind(this);
    var fadeout = this.fadeOutCurrentTab.bind(this);

    var next = this._nextCommand.bind(this);
    var rest = 500; //500ms default rest before measuring an animation
    if (this._config.rest) {
      rest = this._config.rest;
    }

    // NOTE: causes a (slow) reflow, don't use right before measurements.
    function getMaxTabTransitionTimeMs(aTab) {
      let cstyle = window.getComputedStyle(aTab);
      try {
        return 1000 * Math.max.apply(null, cstyle.transitionDuration.split(", ").map(s => parseFloat(s, 10)));
      } catch (e) {
        return 250;
      }
    }

    this.unpinTart();
    var tabRefDuration = getMaxTabTransitionTimeMs(this._tartTab);
    if (tabRefDuration < 20 || tabRefDuration > 2000) {
      // hardcoded fallback in case the value doesn't make sense as tab animation duration.
      tabRefDuration = 250;
    }

    var subtests = {
      init: [ // This is called before each subtest, so it's safe to assume the following prefs:
        function(){Services.prefs.setCharPref("browser.newtab.url", "about:blank");
                   Services.prefs.setBoolPref("browser.newtabpage.enabled", true); // preview images if using about:newtab
                   Services.prefs.setBoolPref("browser.newtab.preload", false);
                   //Services.prefs.setCharPref("layout.css.devPixelsPerPx", "-1");
                   self.pinTart();
                   //Services.prefs.setIntPref ("docshell.event_starvation_delay_hint", 1);
                   next();
        }
      ],

      restore: [
        // Restore prefs which were modified during the test
        function(){Services.prefs.setCharPref("browser.newtab.url", origNewtabUrl);
                   Services.prefs.setBoolPref("browser.newtabpage.enabled", origNewtabEnabled);
                   Services.prefs.setBoolPref("browser.newtab.preload", origPreload);
                   Services.prefs.setCharPref("layout.css.devPixelsPerPx", origDpi);
                   if (origPinned) self.pinTart(); else self.unpinTart();
                   //if (origStarveHint != -9999) Services.prefs.setIntPref("docshell.event_starvation_delay_hint", origStarveHint);
                   next();
        }
      ],

      simple: [
        function(){Services.prefs.setCharPref("layout.css.devPixelsPerPx", "1"); next();},

        function(){animate(0, addTab, next);},
        function(){animate(0, closeCurrentTab, next);},
        function(){animate(rest, addTab, next, true, "simple-open-DPI1", tabRefDuration);},
        function(){animate(rest, closeCurrentTab, next, true, "simple-close-DPI1", tabRefDuration);}
      ],

      iconDpi1: [
        function(){Services.prefs.setCharPref("layout.css.devPixelsPerPx", "1"); next();},
        function(){Services.prefs.setCharPref("browser.newtab.url", "chrome://tart/content/blank.icon.html"); next();},

        function(){animate(0, addTab, next);},
        function(){animate(0, closeCurrentTab, next);},
        function(){animate(rest, addTab, next, true, "icon-open-DPI1", tabRefDuration);},
        function(){animate(rest, closeCurrentTab, next, true, "icon-close-DPI1", tabRefDuration);}
      ],

      iconDpi2: [
        function(){Services.prefs.setCharPref("layout.css.devPixelsPerPx", "2"); next();},
        function(){Services.prefs.setCharPref("browser.newtab.url", "chrome://tart/content/blank.icon.html"); next();},

        function(){animate(0, addTab, next);},
        function(){animate(0, closeCurrentTab, next);},
        function(){animate(rest, addTab, next, true, "icon-open-DPI2", tabRefDuration);},
        function(){animate(rest, closeCurrentTab, next, true, "icon-close-DPI2", tabRefDuration);}
      ],

      newtabNoPreload: [
        function(){Services.prefs.setCharPref("browser.newtab.url", "about:newtab");
                   Services.prefs.setCharPref("layout.css.devPixelsPerPx", "-1");
                   Services.prefs.setBoolPref("browser.newtab.preload", false);
                   next();
        },

        function(){animate(rest, addTab, next, true, "newtab-open-preload-no", tabRefDuration);},

        function(){animate(0, closeCurrentTab, next);}
      ],

      newtabYesPreload: [
        function(){Services.prefs.setCharPref("browser.newtab.url", "about:newtab");
                   Services.prefs.setCharPref("layout.css.devPixelsPerPx", "-1");
                   Services.prefs.setBoolPref("browser.newtab.preload", true);
                   next();
        },

        function(){animate(0, addTab, next);},
        function(){animate(0, closeCurrentTab, next);},

        function(){animate(1000, addTab, next, true, "newtab-open-preload-yes", tabRefDuration);},

        function(){animate(0, closeCurrentTab, next);}
      ],

      simple3open3closeDpiCurrent: [
        function(){animate(rest, addTab, next, true, "simple3-1-open-DPIcurrent", tabRefDuration);},
        function(){animate(rest, addTab, next, true, "simple3-2-open-DPIcurrent", tabRefDuration);},
        function(){animate(rest, addTab, next, true, "simple3-3-open-DPIcurrent", tabRefDuration);},

        function(){animate(rest, closeCurrentTab, next, true, "simple3-3-close-DPIcurrent", tabRefDuration);},
        function(){animate(rest, closeCurrentTab, next, true, "simple3-2-close-DPIcurrent", tabRefDuration);},
        function(){animate(rest, closeCurrentTab, next, true, "simple3-1-close-DPIcurrent", tabRefDuration);}
      ],

      multi: [
        function(){Services.prefs.setCharPref("layout.css.devPixelsPerPx", "1.0"); next();},
        function(){Services.prefs.setCharPref("browser.newtab.url", "chrome://tart/content/blank.icon.html"); next();},

        function(){animate(0, addTab, next);},
        function(){animate(0, addTab, next);},
        function(){animate(0, addTab, next);},
        function(){animate(0, addTab, next);},
        function(){animate(0, addTab, next);},
        function(){animate(0, addTab, next);},

        function(){animate(rest*2, addTab, next, true, "multi-open-DPI1", tabRefDuration);},
        function(){animate(rest*2, closeCurrentTab, next, true, "multi-close-DPI1", tabRefDuration);},

        function(){Services.prefs.setCharPref("layout.css.devPixelsPerPx", "2"); next();},
        function(){animate(0, addTab, next);},
        function(){animate(0, closeCurrentTab, next);},
        function(){animate(rest*2, addTab, next, true, "multi-open-DPI2", tabRefDuration);},
        function(){animate(rest*2, closeCurrentTab, next, true, "multi-close-DPI2", tabRefDuration);},

        function(){Services.prefs.setCharPref("layout.css.devPixelsPerPx", "-1"); next();},

        function(){animate(0, closeCurrentTab, next);},
        function(){animate(0, closeCurrentTab, next);},
        function(){animate(0, closeCurrentTab, next);},
        function(){animate(0, closeCurrentTab, next);},
        function(){animate(0, closeCurrentTab, next);},
        function(){animate(0, closeCurrentTab, next);},
      ],

      simpleFadeDpiCurrent: [
        function(){Services.prefs.setCharPref("browser.newtab.url", "about:blank"); next();},

        function(){animate(0, addTab, next);},
        function(){animate(rest, fadeout, next, true, "simpleFade-close-DPIcurrent", tabRefDuration);},
        function(){animate(rest, fadein, next, true, "simpleFade-open-DPIcurrent", tabRefDuration);},
        function(){animate(0, closeCurrentTab, next);},
      ],

      iconFadeDpiCurrent: [
        function(){Services.prefs.setCharPref("browser.newtab.url", "chrome://tart/content/blank.icon.html"); next();},

        function(){animate(0, addTab, next);},
        function(){animate(rest, fadeout, next, true, "iconFade-close-DPIcurrent", tabRefDuration);},
        function(){animate(rest, fadein, next, true, "iconFade-open-DPIcurrent", tabRefDuration);},
        function(){animate(0, closeCurrentTab, next);},
      ],

      iconFadeDpi2: [
        function(){Services.prefs.setCharPref("layout.css.devPixelsPerPx", "2"); next();},
        function(){Services.prefs.setCharPref("browser.newtab.url", "chrome://tart/content/blank.icon.html"); next();},

        function(){animate(0, addTab, next);},
        function(){animate(rest, fadeout, next, true, "iconFade-close-DPI2", tabRefDuration);},
        function(){animate(rest, fadein, next, true, "iconFade-open-DPI2", tabRefDuration);},
        function(){animate(0, closeCurrentTab, next);},
      ],

      lastTabFadeDpiCurrent: [
        function(){self._win.gBrowser.selectedTab = self._win.gBrowser.tabs[gBrowser.tabs.length - 1];
                   next();},
        function(){animate(rest, fadeout, next, true, "lastTabFade-close-DPIcurrent", tabRefDuration);},
        function(){animate(rest, fadein, next, true, "lastTabFade-open-DPIcurrent", tabRefDuration);},
      ]
    };

    // Construct the sequence array: config.repeat times config.subtests,
    // where each subtest implicitly starts with init.
    sequenceArray = [];
    for (var i in this._config.subtests) {
      for (var r = 0; r < this._config.repeat; r++) {
        sequenceArray = sequenceArray.concat(subtests["init"]);
        sequenceArray = sequenceArray.concat(subtests[this._config.subtests[i]]);
      }
    }
    sequenceArray = sequenceArray.concat(subtests["restore"]);

    this._doSequence(sequenceArray, this._doneInternal);
  },

  startTest: function(doneCallback, config) {
    this._onTestComplete = doneCallback;
    this._config = config;

    const Ci = Components.interfaces;
    var wm = Components.classes["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator);
    this._win = wm.getMostRecentWindow("navigator:browser");
    this._tartTab = this._win.gBrowser.selectedTab;
    this._win.gBrowser.selectedBrowser.focus(); // Unfocus the URL bar to avoid caret blink

    return this._startTest();
  }
}
