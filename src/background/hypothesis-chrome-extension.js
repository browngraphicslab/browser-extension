import BrowserAction from './browser-action';
import directLinkQuery from './direct-link-query';
import * as errors from './errors';
import HelpPage from './help-page';
import settings from './settings';
import SidebarInjector from './sidebar-injector';
import TabState from './tab-state';
import TabStore from './tab-store';

var TAB_STATUS_LOADING = 'loading';
var TAB_STATUS_COMPLETE = 'complete';

/* The main extension application. This wires together all the smaller
 * modules. The app listens to all new created/updated/removed tab events
 * and uses the TabState object to keep track of whether the sidebar is
 * active or inactive in the tab. The app also listens to click events on
 * the browser action and toggles the state and uses the BrowserAction module
 * to update the visual style of the button.
 *
 * The SidebarInjector handles the insertion of the Hypothesis code. If it
 * runs into errors the tab is put into an errored state and when the
 * browser action is clicked again the HelpPage module displays more
 * information to the user.
 *
 * Lastly the TabStore listens to changes to the TabState module and persists
 * the current settings to localStorage. This is then loaded into the
 * application on startup.
 *
 * Relevant Chrome Extension documentation:
 * - https://developer.chrome.com/extensions/browserAction
 * - https://developer.chrome.com/extensions/tabs
 * - https://developer.chrome.com/extensions/extension
 *
 * dependencies - An object to set up the application.
 *   chromeTabs: An instance of chrome.tabs.
 *   chromeBrowserAction: An instance of chrome.browserAction.
 *   extensionURL: chrome.extension.getURL.
 *   isAllowedFileSchemeAccess: chrome.extension.isAllowedFileSchemeAccess.
 */
export default function HypothesisChromeExtension(dependencies) {
  var chromeTabs = dependencies.chromeTabs;
  var chromeExtension = dependencies.chromeExtension;
  var chromeStorage = dependencies.chromeStorage;
  var chromeBrowserAction = dependencies.chromeBrowserAction;
  var help = new HelpPage(chromeTabs, dependencies.extensionURL);
  var store = new TabStore(localStorage);
  var state = new TabState(store.all(), onTabStateChange);
  var browserAction = new BrowserAction(chromeBrowserAction);
  var sidebar = new SidebarInjector(chromeTabs, {
    extensionURL: dependencies.extensionURL,
    isAllowedFileSchemeAccess: dependencies.isAllowedFileSchemeAccess,
  });

  var annotationId = "";
  var annotationUri = "";
  var index = Date.now();

  var linkListenerScript = `document.addEventListener("linkToDash", e => {
      var data = e.detail.split(' ');
      chrome.runtime.sendMessage({ id: data[0], uri: data[1] }); 
    });
    document.body.dashListener = "true";
    console.log("REGISTERING dashListener"); `;

  // If no linkToDash listener has been registered yet, register a listener
  function registerListener(dashListener) {

    // Match the unique dashId to prevent duplicate listeners
    chrome.tabs.executeScript({ code: 'document.body.dashId' }, function (dashId) {
      if ((dashId && dashId.length > 0 && dashId[0] == index)) {
        if (dashListener.length > 0 && !dashListener[0]) {
          chrome.tabs.executeScript({ code: linkListenerScript });
          index++;
        }
      }
    })
  }

  function linkMessageListener (msg) {
    if (msg.id !== undefined && msg.uri !== undefined) {
      annotationId = msg.id;
      annotationUri = msg.uri;
      openDashTab();
    }
  }

  // when switched to Dash tab, send event containing the id and uri of the annotation to be linked to Dash page
  var tabListener = function() {
    if (annotationId) {
      chrome.tabs.executeScript({ code: `document.dispatchEvent(new CustomEvent("linkAnnotationToDash", { 
        detail: { 
          id: "${annotationId}", 
          uri: "${annotationUri}"
        }
      }))` });
      annotationId = "";
      annotationUri = "";
      chrome.tabs.onSelectionChanged.removeListener(tabListener);
    }
  }

  // open Dash tab if one exists in the current window) 
  function openDashTab() {
    var isDash = (url) => url.includes("localhost:1050/doc/") || url.includes("browndash.com/doc/");

    chrome.tabs.query({currentWindow: true, active: true}, function(tabs){
      // notify Dash to start a link from an annotation
      chrome.tabs.executeScript({ code: `document.dispatchEvent(new CustomEvent("linkAnnotationToDash", { 
        detail: { id: "${annotationId}", uri: "${annotationUri}" }
      }))` }); 

      var currentTab = tabs[0];
      !isDash(currentTab.url) && chrome.tabs.query({currentWindow: true}, function(tabs){
        var dashTabs = tabs.filter(t => isDash(t.url));
        if (dashTabs.length) { // find and switch over to the first open Dash tab
            chrome.tabs.executeScript(currentTab.tabId, {code: 'window.stop()'});
            chrome.tabs.onSelectionChanged.addListener(tabListener);
            chrome.tabs.update(dashTabs[0].id, {active:true, selected:true});
        } else { 
          chrome.tabs.create({ url: "https://browndash.com/home" }); // open new Dash tab if none are currently open
        }
      })
    });
  }

  restoreSavedTabState();

  /* Sets up the extension and binds event listeners. Requires a window
   * object to be passed so that it can listen for localStorage events.
   */
  this.listen = function () {
    chromeBrowserAction.onClicked.addListener(onBrowserActionClicked);
    chromeTabs.onCreated.addListener(onTabCreated);

    // when a user navigates within an existing tab,
    // onUpdated is fired in most cases
    chromeTabs.onUpdated.addListener(onTabUpdated);

    // ... but when a user navigates to a page that is loaded
    // via prerendering or instant results, onTabReplaced is
    // fired instead. See https://developer.chrome.com/extensions/tabs#event-onReplaced
    // and https://code.google.com/p/chromium/issues/detail?id=109557
    chromeTabs.onReplaced.addListener(onTabReplaced);

    chromeTabs.onRemoved.addListener(onTabRemoved);
  };

  /* A method that can be used to setup the extension on existing tabs
   * when the extension is re-installed.
   */
  this.install = function () {
    restoreSavedTabState();
  };

  /* Opens the onboarding page */
  this.firstRun = function (extensionInfo) {
    // If we've been installed because of an administrative policy, then don't
    // open the welcome page in a new tab.
    //
    // It's safe to assume that if an admin policy is responsible for installing
    // the extension, opening the welcome page is going to do more harm than
    // good, as it will appear that a tab opened without user action.
    //
    // See:
    //
    //   https://developer.chrome.com/extensions/management#type-ExtensionInstallType
    //
    if (extensionInfo.installType === 'admin') {
      return;
    }

    chromeTabs.create({ url: settings.serviceUrl + 'welcome' }, function (tab) {
      state.activateTab(tab.id);
    });
  };

  function restoreSavedTabState() {
    store.reload();
    state.load(store.all());
    chromeTabs.query({}, function (tabs) {
      tabs.forEach(function (tab) {
        onTabStateChange(tab.id, state.getState(tab.id));
      });
    });
  }

  function onTabStateChange(tabId, current) {
    if (current) {
      browserAction.update(tabId, current);
      chromeTabs.get(tabId, updateTabDocument);

      if (!state.isTabErrored(tabId)) {
        store.set(tabId, current);
      }
    } else {
      store.unset(tabId);
    }
  }

  // exposed for use by tests
  this._onTabStateChange = onTabStateChange;

  function onBrowserActionClicked(tab) {
    var tabError = state.getState(tab.id).error;
    if (tabError) {
      help.showHelpForError(tab, tabError);
    } else if (state.isTabActive(tab.id)) {
      state.deactivateTab(tab.id);
    } else {
      state.activateTab(tab.id);
    }
  }

  /**
   * Returns the active state for a tab
   * which has just been navigated to.
   */
  function activeStateForNavigatedTab(tabId) {
    var activeState = state.getState(tabId).state;
    if (activeState === TabState.states.ERRORED) {
      // user had tried to activate H on the previous page but it failed,
      // retry on the new page
      activeState = TabState.states.ACTIVE;
    }
    return activeState;
  }

  function resetTabState(tabId, url) {
    state.setState(tabId, {
      state: activeStateForNavigatedTab(tabId),
      ready: false,
      annotationCount: 0,
      extensionSidebarInstalled: false,
    });
    updateAnnotationCountIfEnabled(tabId, url);
  }

  // This function will be called multiple times as the tab reloads.
  // https://developer.chrome.com/extensions/tabs#event-onUpdated
  //
  // 'changeInfo' contains details of what changed about the tab's status.
  // Two important events are when the tab's `status` changes to `loading`
  // when the user begins a new navigation and when the tab's status changes
  // to `complete` after the user completes a navigation
  function onTabUpdated(tabId, changeInfo, tab) {
    if (changeInfo.status === TAB_STATUS_LOADING) {
      resetTabState(tabId, tab.url);
      var query = directLinkQuery(tab.url);
      if (query) {
        state.setState(tab.id, { directLinkQuery: query });
      }
    } else if (changeInfo.status === TAB_STATUS_COMPLETE) {
      var tabState = state.getState(tabId);
      var newActiveState = tabState.state;
      if (tabState.directLinkQuery) {
        newActiveState = TabState.states.ACTIVE;
      }
      state.setState(tabId, {
        ready: true,
        state: newActiveState,
      });
    }

    // listen for a linkToDash message from itself
    chrome.runtime.onMessage.removeListener(linkMessageListener);
    chrome.runtime.onMessage.addListener(linkMessageListener);

    // listen for linkToDash event sent from the client's annotator and send message to notify the extension, then send the message to itself
    chrome.tabs.executeScript({ code: `    
      ((document.body.dashId = "${index}") || true) ? document.body.dashListener === 'true' : undefined;`
    }, registerListener)
  }

  function onTabReplaced(addedTabId, removedTabId) {
    state.setState(addedTabId, {
      state: activeStateForNavigatedTab(removedTabId),
      ready: true,
    });
    state.clearTab(removedTabId);

    chromeTabs.get(addedTabId, function (tab) {
      updateAnnotationCountIfEnabled(addedTabId, tab.url);
    });

    chrome.runtime.onMessage.removeListener(linkMessageListener);
    chrome.runtime.onMessage.addListener(linkMessageListener);

    chrome.tabs.executeScript({ code: `    
      ((document.body.dashId = "${index}") || true) ? document.body.dashListener === 'true' : undefined;`
    }, registerListener)
  }

  function onTabCreated(tab) {

    // Clear the state in case there is old, conflicting data in storage.
    state.clearTab(tab.id);
  }

  function onTabRemoved(tabId) {
    state.clearTab(tabId);
  }

  // installs or uninstalls the sidebar from a tab when the H
  // state for a tab changes
  function updateTabDocument(tab) {
    // If the tab has not yet finished loading then just quietly return.
    if (!state.getState(tab.id).ready) {
      return Promise.resolve();
    }

    var isInstalled = state.getState(tab.id).extensionSidebarInstalled;
    if (state.isTabActive(tab.id) && !isInstalled) {
      // optimistically set the state flag indicating that the sidebar
      // has been installed
      state.setState(tab.id, {
        extensionSidebarInstalled: true,
      });

      var { directLinkQuery } = state.getState(tab.id);

      var config = {
        // Configure client to load assets and sidebar app from extension.
        // Note: Even though the sidebar app URL is correct here and the page
        // does load, Chrome devtools may incorrectly report that it failed to
        // load. See https://bugs.chromium.org/p/chromium/issues/detail?id=667533
        assetRoot: chromeExtension.getURL('/client/'),
        sidebarAppUrl: chromeExtension.getURL('/client/app.html'),
      };

      // Pass the direct-link query as configuration into the client.
      //
      // The reason we don't rely on just putting this into the URL and letting
      // the client pick it up is to make direct-linking work in sites/apps
      // that modify the URL fragment as they load. See commit 3143ca27e05d.
      Object.assign(config, directLinkQuery);

      return sidebar
        .injectIntoTab(tab, config)
        .then(function () {
          // Clear the direct link once H has been successfully injected
          state.setState(tab.id, { directLinkQuery: undefined });
        })
        .catch(function (err) {
          if (err instanceof errors.AlreadyInjectedError) {
            state.setState(tab.id, {
              state: TabState.states.INACTIVE,
              extensionSidebarInstalled: false,
            });
            return;
          }
          if (!errors.shouldIgnoreInjectionError(err)) {
            errors.report(err, 'Injecting Hypothesis sidebar', {
              url: tab.url,
            });
          }
          state.errorTab(tab.id, err);
        });
    } else if (state.isTabInactive(tab.id) && isInstalled) {
      return sidebar.removeFromTab(tab).then(function () {
        state.setState(tab.id, {
          extensionSidebarInstalled: false,
        });
      });
    } else {
      return Promise.resolve();
    }
  }

  function updateAnnotationCountIfEnabled(tabId, url) {
    if (!chromeStorage.sync) {
      // Firefox < 53 does not support `chrome.storage.sync`.
      state.updateAnnotationCount(tabId, url);
      return;
    }

    chromeStorage.sync.get(
      {
        badge: true,
      },
      function (items) {
        if (items.badge) {
          state.updateAnnotationCount(tabId, url);
        }
      }
    );
  }
}
