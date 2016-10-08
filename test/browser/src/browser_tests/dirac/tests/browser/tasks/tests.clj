(ns dirac.tests.browser.tasks.tests
  (:require [environ.core :refer [env]]
            [clojure.test :refer :all]
            [clojure.java.io :as io]
            [clojure.stacktrace :as stacktrace]
            [dirac.settings :refer [get-launch-task-message
                                    get-kill-task-message
                                    get-default-task-timeout
                                    get-kill-task-timeout
                                    get-default-test-html-load-timeout
                                    get-signal-server-close-wait-timeout
                                    get-actual-transcripts-root-path
                                    get-expected-transcripts-root-path
                                    get-script-runner-launch-delay
                                    get-fixtures-server-port
                                    get-fixtures-server-url
                                    get-signal-server-host
                                    get-signal-server-port
                                    get-signal-server-max-connection-time
                                    get-task-disconnected-wait-timeout]]
            [dirac.test-lib.fixtures-web-server :refer [with-fixtures-web-server]]
            [dirac.test-lib.nrepl-server :refer [with-nrepl-server]]
            [dirac.test-lib.agent :refer [with-dirac-agent]]
            [dirac.test-lib.chrome-browser :refer [disconnect-browser! reconnect-browser!]]
            [dirac.test-lib.chrome-driver :refer [get-debugging-port extract-javascript-logs]]
            [dirac.lib.ws-server :as server]
            [dirac.utils :as utils]
            [cuerdas.core :as cuerdas]
            [clj-webdriver.taxi :refer :all]
            [clojure.string :as string]
            [clojure.java.shell :as shell]
            [clojure.tools.logging :as log]
            [clansi])
  (:import [java.net URLEncoder]))

; note: we expect current working directory to be dirac root directory ($root)
; $root/test/browser/transcripts/expected/*.txt should contain expected transcripts
; see settings.clj for actual constants

(defonce ^:dynamic *current-transcript-test* nil)
(defonce ^:dynamic *current-transcript-suite* nil)

; -- task state -------------------------------------------------------------------------------------------------------------

(defn make-task-state []
  {:task-success                (volatile! nil)
   :client-disconnected-promise (promise)})

(defn set-task-success! [task-state value]
  (vreset! (:task-success task-state) value))

(defn get-task-success [task-state]
  @(:task-success task-state))

(defn get-task-client-disconnected-promise [task-state]
  (:client-disconnected-promise task-state))

; -- helpers ----------------------------------------------------------------------------------------------------------------

(defn get-transcript-test-label [test-name]
  (str "Transcript test '" test-name "'"))

(defmacro with-transcript-test [test-name & body]
  `(try
     (binding [*current-transcript-test* ~test-name]
       ~@body)
     (catch Throwable e#
       (do-report {:type     :fail
                   :message  (str (get-transcript-test-label ~test-name) " failed.")
                   :expected "no exception"
                   :actual   (str e#)})
       (stacktrace/print-stack-trace e#))))

(defmacro with-transcript-suite [suite-name & body]
  `(binding [*current-transcript-suite* ~suite-name]
     ~@body))

(defn format-friendly-timeout [timeout-ms]
  (utils/timeout-display timeout-ms))

(defn navigation-timeout-message [_test-name load-timeout test-index-url]
  (str "failed to navigate to index page in time (" (utils/timeout-display load-timeout) "): " test-index-url))

(def env-to-be-exported #{:dirac-agent-host
                          :dirac-agent-port
                          :dirac-agent-verbose
                          :dirac-weasel-auto-reconnect
                          :dirac-weasel-verbose})

(defn extract-dirac-env-config-as-url-params [env]
  (let [dirac-pattern #"^dirac-(.*)$"
        relevant-config (into {} (filter (fn [[key _val]] (some #{key} env-to-be-exported)) env))
        strip-prefix (fn [key] (second (re-find dirac-pattern (name key))))
        build-param (fn [key value] (str (URLEncoder/encode key) "=" (URLEncoder/encode value)))]
    (string/join "&" (map (fn [[key val]] (build-param (str "set-" (strip-prefix key)) val)) relevant-config))))

(defn make-test-runner-url [suite-name test-name]
  (let [debugging-port (get-debugging-port)
        extra-params (extract-dirac-env-config-as-url-params env)]
    (str (get-fixtures-server-url) "/runner.html?"
         "task=" suite-name "." test-name
         "&test_runner=1"
         "&debugging_port=" debugging-port
         (if extra-params (str "&" extra-params)))))

(defn navigate-transcript-runner! []
  (let [test-index-url (make-test-runner-url *current-transcript-suite* *current-transcript-test*)
        load-timeout (get-default-test-html-load-timeout)]
    (log/info "navigating to" test-index-url)
    (to test-index-url)
    (try
      (wait-until #(exists? "#status-box") load-timeout)
      (catch Exception e
        (log/error (navigation-timeout-message *current-transcript-test* load-timeout test-index-url))
        (throw e)))))

(defn under-ci? []
  (or (some? (:ci env)) (some? (:travis env))))

(defn enter-infinite-loop []
  (Thread/sleep 1000)
  (recur))

(defn pause-unless-ci []
  (when-not (under-ci?)
    (log/info "paused execution to allow inspection of failed task => CTRL+C to break")
    (enter-infinite-loop)))

; -- signal server ----------------------------------------------------------------------------------------------------------

(defn create-signal-server! [task-state]
  {:pre [(nil? (get-task-client-disconnected-promise task-state))
         (nil? (get-task-success task-state))]}
  (server/create! {:name              "Signal server"
                   :host              (get-signal-server-host)
                   :port              (get-signal-server-port)
                   :on-message        (fn [_server _client msg]
                                        (log/debug "signal server: got signal message" msg)
                                        (case (:op msg)
                                          :ready nil                                                                          ; ignore
                                          :task-result (set-task-success! task-state (:success msg))
                                          (log/error "signal server: received unrecognized message" msg)))
                   :on-leaving-client (fn [_server _client]
                                        (log/debug (str ":on-leaving-client called => wait a bit for possible pending messages"))
                                        ; :on-leaving-client can be called before all :on-message messages get delivered
                                        ; introduce some delay here
                                        (future
                                          ; this is here to give client some time to disconnect before destroying server
                                          ; devtools would spit "Close received after close" errors in js console
                                          (Thread/sleep (get-signal-server-close-wait-timeout))
                                          (log/debug ":on-leaving-client after signal-server-close-wait-timeout")
                                          (assert (some? (get-task-success task-state)) "client leaving but we didn't receive :task-result")
                                          (deliver (get-task-client-disconnected-promise task-state) true)))}))

(defn kill-task! []
  (let [script (str "window.postMessage({type:'" (get-kill-task-message) "'}, '*')")]
    (execute-script script)))

(defn wait-for-client-disconnection! [disconnection-promise timeout-ms]
  (assert (some? disconnection-promise))
  (let [friendly-timeout (format-friendly-timeout timeout-ms)]
    (log/debug (str "wait-for-client-disconnection (timeout " friendly-timeout ")."))
    (if-not (= ::timeouted (deref disconnection-promise timeout-ms ::timeouted))
      true
      (do
        (log/error (str "timeouted while waiting for client disconnection from signal server"))
        (pause-unless-ci)
        false))))

(defn wait-for-signal!
  ([signal-server task-state] (wait-for-signal! signal-server
                                                task-state
                                                (get-default-task-timeout)
                                                (get-kill-task-timeout)
                                                (get-signal-server-max-connection-time)))
  ([signal-server task-state normal-timeout-ms kill-timeout-ms client-disconnection-timeout-ms]
   (let [server-url (server/get-url signal-server)
         client-disconnection-promise (get-task-client-disconnected-promise task-state)
         friendly-normal-timeout (format-friendly-timeout normal-timeout-ms)
         friendly-kill-timeout (format-friendly-timeout kill-timeout-ms)]
     (log/info (str "waiting for a task signal at " server-url " (timeout " friendly-normal-timeout ")."))
     (if (= ::server/timeout (server/wait-for-first-client signal-server normal-timeout-ms))
       (do
         (log/error (str "timeouted while waiting for task signal"
                         " => killing the task... (timeout " friendly-kill-timeout ")"))
         (kill-task!)
         ; give the task a second chance to signal...
         (if (= ::server/timeout (server/wait-for-first-client signal-server kill-timeout-ms))
           (log/error (str "client didn't disconnect even after the kill request, something went really wrong.\n"
                           "This likely means that following tasks will fail too because Chrome debugging port might be still\n"
                           "in use by this non-responsive task (if it still has any devtools instances open).\n"
                           "You will likely see 'Unable to resolve backend-url for Dirac DevTools' kind of errors."))
           (do
             (wait-for-client-disconnection! client-disconnection-promise client-disconnection-timeout-ms)
             (log/info (str "client disconnected after task kill => move to next task"))))
         (set-task-success! task-state false))
       (do
         (if-not (wait-for-client-disconnection! client-disconnection-promise client-disconnection-timeout-ms)
           (set-task-success! task-state false))
         (log/info (str "client disconnected => move to next task"))))
     (assert (some? (get-task-success task-state)) "didn't get task-result message from signal client?")
     (when-not (get-task-success task-state)
       (log/error (str "task reported a failure"))
       (pause-unless-ci))
     (server/destroy! signal-server))))

; -- transcript helpers -----------------------------------------------------------------------------------------------------

(defn get-current-test-full-name []
  (let [test-name *current-transcript-test*
        suite-name *current-transcript-suite*]
    (str suite-name "-" test-name)))

(defn get-actual-transcript-path-filename [suite-name test-name]
  (str suite-name "-" test-name ".txt"))

(defn get-actual-transcript-path [suite-name test-name]
  (str (get-actual-transcripts-root-path) (get-actual-transcript-path-filename suite-name test-name)))

(defn get-expected-transcript-filename [suite-name test-name]
  (str suite-name "-" test-name ".txt"))

(defn get-expected-transcript-path [suite-name test-name]
  (str (get-expected-transcripts-root-path) (get-expected-transcript-filename suite-name test-name)))

(defn get-canonical-line [line]
  (string/trimr line))

(defn significant-line? [line]
  (not (empty? line)))

(defn append-nl [text]
  (str text "\n"))

(defn get-canonical-transcript [transcript]
  (->> transcript
       (cuerdas/lines)
       (map get-canonical-line)
       (filter significant-line?)                                                                                             ; filter empty lines to work around end-of-the-file new-line issue
       (cuerdas/unlines)
       (append-nl)))                                                                                                          ; we want to be compatible with "copy transcript!" button which copies to clipboard with extra new-line

(defn obtain-transcript []
  (let [test-index-url (make-test-runner-url *current-transcript-suite* *current-transcript-test*)]
    (if-let [test-window-handle (find-window {:url test-index-url})]
      (try
        (switch-to-window test-window-handle)
        (text "#transcript")
        (catch Exception _e
          (throw (ex-info "unable to read transcript" {:body (str "===== DOC BODY =====\n"
                                                                  (text "body")
                                                                  "\n====================\n")}))))
      (throw (ex-info "unable to find window with transcript" {:test-index-url test-index-url})))))

(defn write-transcript! [path transcript]
  (io/make-parents path)
  (spit path transcript))

(defn produce-diff [path1 path2]
  (let [options-args ["-U" "5"]
        paths-args [path1 path2]]
    (try
      (let [result (apply shell/sh "colordiff" (concat options-args paths-args))]
        (if-not (empty? (:err result))
          (clansi/style (str "! " (:err result)) :red)
          (:out result)))
      (catch Throwable e
        (clansi/style (str "! " (.getMessage e)) :red)))))

(defn write-transcript-and-compare []
  (let [test-name *current-transcript-test*
        suite-name *current-transcript-suite*]
    (try
      (when-let [logs (extract-javascript-logs)]
        (println)
        (println (str "*************** JAVASCRIPT LOGS ***************\n" logs))
        (println))
      (let [actual-transcript (get-canonical-transcript (obtain-transcript))
            actual-path (get-actual-transcript-path suite-name test-name)]
        (write-transcript! actual-path actual-transcript)
        (let [expected-path (get-expected-transcript-path suite-name test-name)
              expected-transcript (get-canonical-transcript (slurp expected-path))]
          (when-not (= actual-transcript expected-transcript)
            (println)
            (println "-----------------------------------------------------------------------------------------------------")
            (println (str "! actual transcript differs for " test-name " test:"))
            (println)
            (println (produce-diff expected-path actual-path))
            (println "-----------------------------------------------------------------------------------------------------")
            (println (str "> cat " actual-path))
            (println)
            (println actual-transcript)
            (do-report {:type     :fail
                        :message  (str (get-transcript-test-label test-name) " failed to match expected transcript.")
                        :expected (str "to match expected transcript " expected-path)
                        :actual   (str "didn't match, see " actual-path)}))
          (do-report {:type    :pass
                      :message (str (get-transcript-test-label test-name) " passed.")})))
      (catch Throwable e
        (do-report {:type     :fail
                    :message  (str (get-transcript-test-label test-name) " failed with an exception.")
                    :expected "no exception"
                    :actual   (str e)})
        (stacktrace/print-stack-trace e)))))

(defn launch-transcript-test-after-delay [delay-ms]
  {:pre [(integer? delay-ms) (not (neg? delay-ms))]}
  (let [script (str "window.postMessage({type:'" (get-launch-task-message) "', delay: " delay-ms "}, '*')")]
    (execute-script script)))

(defn get-browser-test-filter []
  (env :dirac-browser-test-filter))

(defn should-skip-current-test? []
  (boolean
    (if-let [filter-string (get-browser-test-filter)]
      (let [filtered-test-names (string/split filter-string #"\s")
            full-test-name (get-current-test-full-name)]
        (not (some #(string/includes? full-test-name %) filtered-test-names))))))

(defn execute-transcript-test! [test-name]
  (with-transcript-test test-name
    (if (should-skip-current-test?)
      (println (str "Skipped test '" (get-current-test-full-name) "' due to filter '" (get-browser-test-filter) "'"))
      (let [task-state (make-task-state)
            signal-server (create-signal-server! task-state)]
        (navigate-transcript-runner!)
        ; chrome driver needs some time to cooldown after disconnection
        ; to prevent random org.openqa.selenium.SessionNotCreatedException exceptions
        ; also we want to run our transcript test safely after debugger port is available
        ; for devtools after driver disconnection
        (launch-transcript-test-after-delay (get-script-runner-launch-delay))
        (disconnect-browser!)
        (wait-for-signal! signal-server task-state)
        (Thread/sleep (get-task-disconnected-wait-timeout))
        (reconnect-browser!)
        (write-transcript-and-compare)))))

; -- fixtures ---------------------------------------------------------------------------------------------------------------

(use-fixtures :once with-fixtures-web-server with-nrepl-server with-dirac-agent)

; -- individual tests -------------------------------------------------------------------------------------------------------

(defn fixtures-web-server-check []
  (to (get-fixtures-server-url))
  (is (= (text "body") "fixtures web-server ready")))

; to run only selected tests run something like this (fish shell):
; > env DIRAC_BROWSER_TEST_FILTER="error-feedback welcome" lein test-browser
(deftest test-all
  (fixtures-web-server-check)
  (with-transcript-suite "suite01"
    (execute-transcript-test! "barebone")
    (execute-transcript-test! "preloads")
    (execute-transcript-test! "runtime-api")
    (execute-transcript-test! "no-agent")
    (execute-transcript-test! "version-checks")
    (execute-transcript-test! "console")
    (execute-transcript-test! "repl")
    (execute-transcript-test! "completions")
    (execute-transcript-test! "options")
    (execute-transcript-test! "error-feedback")
    (execute-transcript-test! "misc"))
  (with-transcript-suite "suite02"
    (execute-transcript-test! "welcome-message")
    (execute-transcript-test! "enable-parinfer")
    (execute-transcript-test! "clean-urls")
    (execute-transcript-test! "beautify-function-names")))
