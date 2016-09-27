; nREPL middleware enabling the transparent use of a ClojureScript REPL with nREPL tooling.
; taken from https://github.com/cemerick/piggieback/tree/440b2d03f944f6418844c2fab1e0361387eed543
; original author: Chas Emerick
; Eclipse Public License - v 1.0
;
; this file differs significantly from the original piggieback.clj and was modified to include Dirac-specific functionality
;
(ns dirac.nrepl.piggieback
  (:require (clojure.tools.nrepl [transport :as transport]
                                 [misc :refer (response-for returning)]
                                 [middleware :refer (set-descriptor!)])
            [clojure.tools.nrepl.middleware.interruptible-eval :as nrepl-ieval]
            [clojure.tools.nrepl.transport :as nrepl-transport]
            [clojure.main]
            [cljs.repl]
            [dirac.nrepl.state :as state]
            [dirac.nrepl.driver :as driver]
            [dirac.nrepl.version :refer [version]]
            [dirac.nrepl.sessions :as sessions]
            [dirac.nrepl.helpers :as helpers]
            [dirac.nrepl.jobs :as jobs]
            [dirac.nrepl.debug :as debug]
            [dirac.nrepl.compilers :as compilers]
            [dirac.nrepl.controls :as controls]
            [clojure.tools.logging :as log]
            [clojure.string :as string]
            [cljs.analyzer :as analyzer]
            [dirac.logging :as logging]
            [dirac.nrepl.config :as config])
  (:import clojure.lang.LineNumberingPushbackReader
           java.io.StringReader
           java.io.Writer
           (clojure.tools.nrepl.transport Transport)
           (clojure.lang IDeref))
  (:refer-clojure :exclude (load-file)))

(defn ^:dynamic make-dirac-repl-alias [compiler-id]
  (str "<" (or compiler-id "?") ">"))

(defn ^:dynamic make-no-target-session-help-msg [info]
  (str "Your session joined Dirac but no connected Dirac session is \"" info "\".\n"
       "You can review the list of currently available Dirac sessions via `(dirac! :ls)`.\n"
       "You can join one of them with `(dirac! :join)`.\n"
       "See `(dirac! :help)` for more info."))

(defn ^:dynamic make-no-target-session-match-msg [_info]
  (str "No suitable Dirac session is connected to handle your command."))

(defn ^:dynamic make-nrepl-message-cannot-be-forwarded-msg [message-info]
  (str "Encountered an nREPL message which cannot be forwarded to joined Dirac session:\n"
       message-info))

(defn ^:dynamic make-no-forwarding-help-msg [op]
  (str "Your have a joined Dirac session and your nREPL client just sent an unsupported nREPL operation to it.\n"
       "Ask Dirac developers to implement '" op "' op: https://github.com/binaryage/dirac/issues."))

(defn ^:dynamic make-missing-compiler-msg [selected-compiler available-compilers]
  (str "Selected compiler '" selected-compiler "' is missing. "
       "It does not match any of available compilers: " (pr-str available-compilers) ".\n"
       "Use `(dirac! :ls)` to review current situation and "
       "`(dirac! :switch <compiler-id>)` to switch to an existing compiler."))

; -- helpers ----------------------------------------------------------------------------------------------------------------

(defn send-response! [nrepl-message response-msg]
  (let [transport (:transport nrepl-message)]
    (assert transport)
    (transport/send transport (response-for nrepl-message response-msg))))

(defn make-server-side-output-msg [kind content]
  {:pre [(contains? #{:stderr :stdout} kind)
         (string? content)]}
  {:op      :print-output
   :kind    kind
   :content content})

; -- dirac-specific wrapper for evaluated forms -----------------------------------------------------------------------------

(defn safe-value-conversion-to-string [value]
  ; darwin: I have a feeling that these cljs.core bindings should not be hard-coded.
  ;         I understand that printing must be limited somehow. But this should be user-configurable.
  ;         Dirac REPL does not use returned string value - but normal nREPL clients are affected by this.
  `(binding [cljs.core/*print-level* 1
             cljs.core/*print-length* 10]
     (cljs.core/pr-str ~value)))

(defn make-wrap-for-job [job-id]
  (fn [form]
    `(try
       (js/dirac.runtime.repl.present_repl_result ~job-id ~form)
       (catch :default e#
         (js/dirac.runtime.repl.present_repl_exception ~job-id e#)
         (throw e#)))))

(defn make-job-evaluator [dirac-wrap job-id]
  (fn [form]
    (let [result-sym (gensym "result")]
      `(try
         ; we want to redirect all side-effect printing to dirac.runtime, so it can be presented in the Dirac REPL console
         (binding [cljs.core/*print-newline* false
                   cljs.core/*print-fn* (partial js/dirac.runtime.repl.present_output ~job-id "stdout")
                   cljs.core/*print-err-fn* (partial js/dirac.runtime.repl.present_output ~job-id "stderr")]
           (let [~result-sym ~(dirac-wrap form)]
             (set! *3 *2)
             (set! *2 *1)
             (set! *1 ~result-sym)
             ~(safe-value-conversion-to-string result-sym)))
         (catch :default e#
           (set! *e e#)
           (throw e#))))))

(defn make-special-form-evaluator [dirac-wrap]
  (fn [form]
    (safe-value-conversion-to-string (dirac-wrap form))))

(defn make-wrapper-for-form [form]
  (let [nrepl-message nrepl-ieval/*msg*
        dirac-mode (:dirac nrepl-message)
        job-id (or (:id nrepl-message) 0)
        dirac-wrap (case dirac-mode
                     "wrap" (make-wrap-for-job job-id)
                     identity)]
    (cond
      (and (seq? form) (= 'ns (first form))) identity
      ('#{*1 *2 *3 *e} form) (make-special-form-evaluator dirac-wrap)
      :else (make-job-evaluator dirac-wrap job-id))))

(defn set-env-namespace [env]
  (assoc env :ns (analyzer/get-namespace analyzer/*cljs-ns*)))

(defn extract-scope-locals [scope-info]
  (mapcat :props (:frames scope-info)))

; extract locals from scope-info (as provided by Dirac) and put it into :locals env map for analyzer
; note in case of duplicit names we won't break, resulting locals is a flat list: "last name wins"
(defn set-env-locals [env]
  (let [nrepl-message nrepl-ieval/*msg*
        scope-info (:scope-info nrepl-message)
        all-scope-locals (extract-scope-locals scope-info)
        build-env-local (fn [local]
                          (let [{:keys [name identifier]} local
                                name-sym (symbol name)
                                identifier-sym (if identifier (symbol identifier) name-sym)]
                            [name-sym {:name identifier-sym}]))
        env-locals (into {} (map build-env-local all-scope-locals))]
    (assoc env :locals env-locals)))

(defn eval-cljs
  "Given a REPL evaluation environment, an analysis environment, and a
   form, evaluate the form and return the result. The result is always the value
   represented as a string."
  ([repl-env env form] (eval-cljs repl-env env form cljs.repl/*repl-opts*))
  ([repl-env env form opts]
   (let [wrapper-fn (or (:wrap opts) make-wrapper-for-form)
         wrapped-form (wrapper-fn form)
         effective-env (-> env set-env-namespace set-env-locals)
         filename (make-dirac-repl-alias (compilers/get-selected-compiler-id))]
     (log/debug "eval-cljs in " filename ":\n" form "\n with env:\n" (logging/pprint effective-env 7))
     (cljs.repl/evaluate-form repl-env effective-env filename form wrapped-form opts))))

(defn execute-single-cljs-repl-evaluation! [job-id code ns repl-env compiler-env repl-options response-fn]
  (let [flush-fn (fn []
                   (log/trace "flush-fn > ")
                   (.flush ^Writer *out*)
                   (.flush ^Writer *err*))
        print-fn (fn [result]
                   (log/trace "print-fn > " result)
                   (response-fn (compilers/prepare-announce-ns-msg analyzer/*cljs-ns* result)))
        base-repl-options {:need-prompt  (constantly false)
                           :bind-err     false
                           :quit-prompt  (fn [])
                           :prompt       (fn [])
                           :init         (fn [])
                           :flush        flush-fn
                           :print        print-fn
                           :eval         eval-cljs
                           :compiler-env compiler-env}
        effective-repl-options (merge base-repl-options repl-options)
        ; MAJOR TRICK HERE!
        ; we append :cljs/quit to our code which should be evaluated
        ; this will cause cljs.repl loop to exit after the first eval
        code-reader-with-quit (-> (str code " :cljs/quit")
                                  StringReader.
                                  LineNumberingPushbackReader.)
        initial-ns (if ns
                     (symbol ns)
                     (state/get-session-cljs-ns))
        start-repl-fn (fn [driver repl-env repl-options]
                        (driver/start-job! driver job-id)
                        (log/trace "calling cljs.repl/repl* with:\n" (logging/pprint repl-env) (logging/pprint repl-options))
                        (cljs.repl/repl* repl-env repl-options)
                        (driver/stop-job! driver))]
    (binding [*in* code-reader-with-quit
              *out* (state/get-session-binding-value #'*out*)
              *err* (state/get-session-binding-value #'*err*)
              analyzer/*cljs-ns* initial-ns]
      (driver/wrap-repl-with-driver repl-env effective-repl-options start-repl-fn response-fn)
      (let [final-ns analyzer/*cljs-ns*]                                                                                      ; we want analyzer/*cljs-ns* to be sticky between evaluations, that is why we keep it in our session state and bind it
        (if-not (= final-ns initial-ns)
          (state/set-session-cljs-ns! final-ns))))))

(defn start-new-cljs-compiler-repl-environment! [dirac-nrepl-config repl-env repl-options]
  (log/trace "start-new-cljs-compiler-repl-environment!\n")
  (let [nrepl-message (state/get-nrepl-message)
        compiler-env nil
        code (or (:repl-init-code dirac-nrepl-config) config/standard-repl-init-code)
        job-id (or (:id nrepl-message) (helpers/generate-uuid))
        ns (:ns nrepl-message)
        effective-repl-options (assoc repl-options
                                 ; the first run through the cljs REPL is effectively part
                                 ; of setup; loading core, (ns cljs.user ...), etc, should
                                 ; not yield a value. But, we do capture the compiler
                                 ; environment now (instead of attempting to create one to
                                 ; begin with, because we can't reliably replicate what
                                 ; cljs.repl/repl* does in terms of options munging
                                 :init (fn []
                                         (log/trace "init-fn > ")
                                         (compilers/capture-current-compiler-and-select-it!))
                                 :print (fn [& _]
                                          (log/trace "print-fn (no-op)")))                                                    ; silence any responses
        response-fn (partial send-response! nrepl-message)]
    (execute-single-cljs-repl-evaluation! job-id code ns repl-env compiler-env effective-repl-options response-fn)))

(defn start-cljs-repl! [dirac-nrepl-config repl-env repl-options]
  (log/trace "start-cljs-repl!\n"
             "dirac-nrepl-config:\n"
             (logging/pprint dirac-nrepl-config)
             "repl-env:\n"
             (logging/pprint repl-env)
             "repl-options:\n"
             (logging/pprint repl-options))
  (debug/log-stack-trace!)
  (state/ensure-session nrepl-ieval/*msg*
    (try
      (state/set-session-cljs-ns! 'cljs.user)
      (let [preferred-compiler (or (:preferred-compiler dirac-nrepl-config) "dirac/new")]
        (if (= preferred-compiler "dirac/new")
          (start-new-cljs-compiler-repl-environment! dirac-nrepl-config repl-env repl-options)
          (state/set-session-selected-compiler! preferred-compiler)))                                                         ; TODO: validate that preferred compiler exists
      (state/set-session-cljs-repl-env! repl-env)
      (state/set-session-cljs-repl-options! repl-options)
      (state/set-session-original-clj-ns! *ns*)                                                                               ; interruptible-eval is in charge of emitting the final :ns response in this context
      (set! *ns* (find-ns (state/get-session-cljs-ns)))                                                                       ; TODO: is this really needed? is it for macros?
      (send-response! (state/get-nrepl-message) (compilers/prepare-announce-ns-msg (state/get-session-cljs-ns)))
      (catch Exception e
        (state/set-session-cljs-repl-env! nil)
        (throw e)))))

;; mostly a copy/paste from interruptible-eval
(defn enqueue! [nrepl-message func]
  (let [{:keys [session transport]} nrepl-message
        job (fn []
              (alter-meta! session
                           assoc
                           :thread (Thread/currentThread)
                           :eval-msg nrepl-message)
              (binding [nrepl-ieval/*msg* nrepl-message]
                (state/ensure-session nrepl-message
                  (func))
                (transport/send transport (response-for nrepl-message :status :done)))
              (alter-meta! session
                           dissoc
                           :thread
                           :eval-msg))]
    (nrepl-ieval/queue-eval session @nrepl-ieval/default-executor job)))

(defn report-missing-compiler! [selected-compiler available-compilers]
  (let [msg (make-missing-compiler-msg selected-compiler available-compilers)]
    (send-response! (state/get-nrepl-message) (make-server-side-output-msg :stderr msg))))

; only executed within the context of an nREPL session having *cljs-repl-env*
; bound. Thus, we're not going through interruptible-eval, and the user's
; Clojure session (dynamic environment) is not in place, so we need to go
; through the `session` atom to access/update its vars. Same goes for load-file.
(defn evaluate! [nrepl-message]
  (debug/log-stack-trace!)
  (let [{:keys [session ^String code]} nrepl-message
        cljs-repl-env (state/get-session-cljs-repl-env)]
    ; we append a :cljs/quit to every chunk of code evaluated so we can break out of cljs.repl/repl*'s loop,
    ; so we need to go a gnarly little stringy check here to catch any actual user-supplied exit
    (if-not (.. code trim (endsWith ":cljs/quit"))
      (let [nrepl-message (state/get-nrepl-message)
            job-id (or (:id nrepl-message) (helpers/generate-uuid))
            ns (:ns nrepl-message)
            selected-compiler (state/get-session-selected-compiler)
            cljs-repl-options (state/get-session-cljs-repl-options)
            response-fn (partial send-response! nrepl-message)]
        (if-let [compiler-env (compilers/provide-selected-compiler-env)]
          (execute-single-cljs-repl-evaluation! job-id code ns cljs-repl-env compiler-env cljs-repl-options response-fn)
          (report-missing-compiler! selected-compiler (compilers/collect-all-available-compiler-ids))))
      (do
        (reset! (:cached-setup cljs-repl-env) :tear-down)                                                                     ; TODO: find a better way
        (cljs.repl/-tear-down cljs-repl-env)
        (sessions/remove-dirac-session-descriptor! session)
        (swap! session assoc #'*ns* (state/get-session-original-clj-ns))                                                      ; TODO: is this really needed?
        (let [reply (compilers/prepare-announce-ns-msg (str (state/get-session-original-clj-ns)))]
          (send-response! nrepl-message reply))))))

; struggled for too long trying to interface directly with cljs.repl/load-file,
; so just mocking a "regular" load-file call
; this seems to work perfectly, *but* it only loads the content of the file from
; disk, not the content of the file sent in the message (in contrast to nREPL on
; Clojure). This is necessitated by the expectation of cljs.repl/load-file that
; the file being loaded is on disk, in the location implied by the namespace
; declaration.
; TODO either pull in our own `load-file` that doesn't imply this, or raise the issue upstream.
(defn load-file! [nrepl-message]
  (let [{:keys [file-path]} nrepl-message]
    (evaluate! (assoc nrepl-message :code (format "(load-file %s)" (pr-str file-path))))))

; -- nrepl-message error observer -------------------------------------------------------------------------------------------

(defn get-session-exception [session]
  {:pre [(instance? IDeref session)]}
  (@session #'clojure.core/*e))

(defn get-nrepl-message-info [nrepl-message]
  (let [{:keys [op code]} nrepl-message]
    (str "op: '" op "'" (if (some? code) (str " code: " code)))))

(defn get-exception-details [nrepl-message e]
  (let [details (driver/capture-exception-details e)
        message-info (get-nrepl-message-info nrepl-message)]
    (str message-info "\n" details)))

(defrecord ErrorsObservingTransport [nrepl-message transport]
  Transport
  (recv [_this timeout]
    (nrepl-transport/recv transport timeout))
  (send [_this reply-message]
    (let [effective-message (if (some #{:eval-error} (:status reply-message))
                              (let [e (get-session-exception (:session nrepl-message))
                                    details (get-exception-details nrepl-message e)]
                                (log/error (str "Clojure eval error: " details))
                                (assoc reply-message :details details))
                              reply-message)]
      (nrepl-transport/send transport effective-message))))

(defn observed-nrepl-message [nrepl-message]
  ; This is a little trick due to unfortunate fact that clojure.tools.nrepl.middleware.interruptible-eval/evaluate does not
  ; offer configurable :caught option. The problem is that eval errors in Clojure REPL are not printed to stderr
  ; for some reasons and reported exception in response message is not helpful.
  ;
  ; Our strategy here is to wrap :transport with our custom implementation which observes send calls and enhances :eval-error
  ; messages with more details. It relies on the fact that :caught implementation
  ; in clojure.tools.nrepl.middleware.interruptible-eval/evaluate sets exception into *e binding in the session atom.
  ;
  ; Also it uses our logging infrastructure to log the error which should be displayed in console (assuming default log
  ; levels)
  (update nrepl-message :transport (partial ->ErrorsObservingTransport nrepl-message)))

; -- handlers for middleware operations -------------------------------------------------------------------------------------

(defn safe-pr-str [value & [level length]]
  (binding [*print-level* (or level 5)
            *print-length* (or length 100)]
    (pr-str value)))

(defrecord LoggingTransport [nrepl-message transport]
  Transport
  (recv [_this timeout]
    (nrepl-transport/recv transport timeout))
  (send [_this reply-message]
    (log/debug (str "sending raw message via nREPL transport: " transport " \n") (logging/pprint reply-message))
    (debug/log-stack-trace!)
    (nrepl-transport/send transport reply-message)))

(defn logged-nrepl-message [nrepl-message]
  (update nrepl-message :transport (partial ->LoggingTransport nrepl-message)))

(defn make-print-output-message [base job-id output-kind content]
  (-> base
      (dissoc :out)
      (dissoc :err)
      (merge {:op      :print-output
              :id      job-id
              :kind    output-kind
              :content content})))

(defrecord OutputCapturingTransport [nrepl-message transport]
  Transport
  (recv [_this timeout]
    (nrepl-transport/recv transport timeout))
  (send [_this reply-message]
    (if-let [content (:out reply-message)]
      (nrepl-transport/send transport (make-print-output-message reply-message (:id nrepl-message) :stdout content)))
    (if-let [content (:err reply-message)]
      (nrepl-transport/send transport (make-print-output-message reply-message (:id nrepl-message) :stderr content)))
    (nrepl-transport/send transport reply-message)))

(defn make-nrepl-message-with-captured-output [nrepl-message]
  ; repl-eval! does not have our sniffing driver in place, we capture output
  ; by observing :out and :err keys in replied messages
  ; this is good enough because we know that our controls.clj implementation does not do anything crazy and uses
  ; standard *out* and *err* for printing outputs so that normal nREPL output capturing works
  (update nrepl-message :transport (partial ->OutputCapturingTransport nrepl-message)))

(defn dirac-special-command? [nrepl-message]
  (let [code (:code nrepl-message)]
    (if (string? code)
      (some? (re-find #"^\(?dirac!" code)))))                                                                                 ; we don't want to use read-string here, regexp test should be safe and quick

(defn repl-eval! [nrepl-message code ns]
  (let [{:keys [transport session]} nrepl-message
        bindings @session
        out (bindings #'*out*)
        err (bindings #'*err*)]
    (let [result (with-bindings bindings
                   (try
                     (let [form (read-string code)]
                       (binding [state/*reply!* #(send-response! nrepl-message %)
                                 *ns* ns
                                 nrepl-ieval/*msg* nrepl-message]
                         (eval form)))
                     (catch Throwable e
                       (let [root-ex (clojure.main/root-cause e)
                             details (get-exception-details nrepl-message e)]
                         (log/error (str "Clojure eval error during eval of a special dirac command: " details))
                         ; repl-caught will produce :err message, but we are not under driver, so it won't be converted to :print-output
                         ; that is why we present error output to user REPL manually
                         (clojure.main/repl-caught e)
                         (transport/send transport (response-for nrepl-message
                                                                 :op :print-output
                                                                 :kind :java-trace
                                                                 :content (driver/capture-exception-details e)))
                         (transport/send transport (response-for nrepl-message
                                                                 :status :eval-error
                                                                 :ex (-> e class str)
                                                                 :root-ex (-> root-ex class str)
                                                                 :details details))
                         ::exception))
                     (finally
                       (.flush ^Writer out)
                       (.flush ^Writer err))))
          base-reply {:status :done}
          reply (if (= ::controls/no-result ::exception result)
                  base-reply
                  (assoc base-reply
                    :value (safe-pr-str result)
                    :printed-value 1))]
      (if-not (= ::exception result)
        (transport/send transport (response-for nrepl-message reply))))))

(defn sanitize-dirac-command [code]
  ; this is just for convenience, we convert some common forms to canonical (dirac! :help) form
  (let [trimmed-code (string/trim code)]
    (if (or (= trimmed-code "dirac!")
            (= trimmed-code "(dirac!)"))
      "(dirac! :help)"
      trimmed-code)))

(defn handle-dirac-special-command! [nrepl-message]
  (let [{:keys [code session]} nrepl-message
        message (if (sessions/dirac-session? session)
                  (make-nrepl-message-with-captured-output nrepl-message)
                  nrepl-message)]
    (repl-eval! message (sanitize-dirac-command code) (find-ns 'dirac.nrepl.controls))))                                      ; we want to eval special commands in dirac.nrepl.controls namespace

(defn prepare-no-target-session-match-error-message [session]
  (let [info (sessions/get-target-session-info session)]
    (str (make-no-target-session-match-msg info) "\n")))

(defn prepare-no-target-session-match-help-message [session]
  (let [info (sessions/get-target-session-info session)]
    (str (make-no-target-session-help-msg info) "\n")))

(defn report-missing-target-session! [nrepl-message]
  (log/debug "report-missing-target-session!")
  (let [{:keys [transport session]} nrepl-message]
    (transport/send transport (response-for nrepl-message
                                            :err (prepare-no-target-session-match-error-message session)))
    (transport/send transport (response-for nrepl-message
                                            :out (prepare-no-target-session-match-help-message session)))
    (transport/send transport (response-for nrepl-message
                                            :status :done))))

(defn report-nonforwardable-nrepl-message! [nrepl-message]
  (log/debug "report-nonforwardable-nrepl-message!")
  (let [{:keys [op transport]} nrepl-message
        clean-message (dissoc nrepl-message :session :transport)]
    (transport/send transport (response-for nrepl-message
                                            :err (str (make-nrepl-message-cannot-be-forwarded-msg (pr-str clean-message)) "\n")))
    (transport/send transport (response-for nrepl-message
                                            :out (str (make-no-forwarding-help-msg (or op "?")) "\n")))
    (transport/send transport (response-for nrepl-message
                                            :status :done))))

(defn enqueue-command! [command nrepl-message]
  (enqueue! nrepl-message #(command nrepl-message)))

(defn prepare-forwardable-message [nrepl-message]
  ; based on what is currently supported by intercom on client-side
  ; we deliberately filter keys to a "safe" subset, so the message can be unserialize on client side
  (case (:op nrepl-message)
    "eval" (select-keys nrepl-message [:id :op :code])
    "load-file" (select-keys nrepl-message [:id :op :file :file-path :file-name])
    "interrupt" (select-keys nrepl-message [:id :op :interrupt-id])
    nil))

(defn serialize-message [nrepl-message]
  (pr-str nrepl-message))

(defn forward-message-to-joined-session! [nrepl-message]
  (log/trace "forward-message-to-joined-session!" (logging/pprint nrepl-message))
  (let [{:keys [id session transport]} nrepl-message]
    (if-let [target-dirac-session-descriptor (sessions/find-target-dirac-session-descriptor session)]
      (if-let [forwardable-message (prepare-forwardable-message nrepl-message)]
        (let [target-session (sessions/get-dirac-session-descriptor-session target-dirac-session-descriptor)
              target-transport (sessions/get-dirac-session-descriptor-transport target-dirac-session-descriptor)
              job-id (helpers/generate-uuid)]
          (jobs/register-observed-job! job-id id session transport 1000)
          (transport/send target-transport {:op                                 :handle-forwarded-nrepl-message
                                            :id                                 (helpers/generate-uuid)                       ; our request id
                                            :session                            (sessions/get-session-id target-session)
                                            :job-id                             job-id                                        ; id under which the job should be started
                                            :serialized-forwarded-nrepl-message (serialize-message forwardable-message)}))
        (report-nonforwardable-nrepl-message! nrepl-message))
      (report-missing-target-session! nrepl-message))))

(defn handle-identify-dirac-nrepl-middleware! [_next-handler nrepl-message]
  (let [{:keys [transport]} nrepl-message]
    (transport/send transport (response-for nrepl-message
                                            :version version))))

(defn handle-eval! [next-handler nrepl-message]
  (let [{:keys [session]} nrepl-message]
    (cond
      (sessions/dirac-session? session) (enqueue-command! evaluate! nrepl-message)
      :else (next-handler (observed-nrepl-message nrepl-message)))))

(defn handle-load-file! [next-handler nrepl-message]
  (let [{:keys [session]} nrepl-message]
    (if (sessions/dirac-session? session)
      (enqueue-command! load-file! nrepl-message)
      (next-handler (observed-nrepl-message nrepl-message)))))

(defn final-message? [message]
  (some? (:status message)))

(defrecord ObservingTransport [observed-job nrepl-message transport]
  Transport
  (recv [_this timeout]
    (nrepl-transport/recv transport timeout))
  (send [_this reply-message]
    (let [observing-transport (jobs/get-observed-job-transport observed-job)
          observing-session (jobs/get-observed-job-session observed-job)
          initial-message-id (jobs/get-observed-job-message-id observed-job)
          artificial-message (assoc reply-message
                               :id initial-message-id
                               :session (sessions/get-session-id observing-session))]
      (log/debug "sending message to observing session" observing-session (logging/pprint artificial-message))
      (nrepl-transport/send observing-transport artificial-message))
    (if (final-message? reply-message)
      (jobs/unregister-observed-job! (jobs/get-observed-job-id observed-job)))
    (nrepl-transport/send transport reply-message)))

(defn make-nrepl-message-with-observing-transport [observed-job nrepl-message]
  (log/trace "make-nrepl-message-with-observing-transport" observed-job (logging/pprint nrepl-message))
  (update nrepl-message :transport (partial ->ObservingTransport observed-job nrepl-message)))

(defn wrap-nrepl-message-if-observed [nrepl-message]
  (if-let [observed-job (jobs/get-observed-job nrepl-message)]
    (make-nrepl-message-with-observing-transport observed-job nrepl-message)
    nrepl-message))

(defn is-eval-cljs-quit-in-joined-session? [nrepl-message]
  (and (= (:op nrepl-message) "eval")
       (= ":cljs/quit" (string/trim (:code nrepl-message)))
       (sessions/joined-session? (:session nrepl-message))))

(defn issue-dirac-special-command! [nrepl-message command]
  (log/debug "issue-dirac-special-command!" command)
  (handle-dirac-special-command! (assoc nrepl-message :code (str "(dirac! " command ")"))))

(defn handle-finish-dirac-job! [nrepl-message]
  (log/debug "handle-finish-dirac-job!")
  (let [{:keys [transport]} nrepl-message]
    (transport/send transport (response-for nrepl-message (select-keys nrepl-message [:status :err :out])))))

; -- nrepl middleware -------------------------------------------------------------------------------------------------------

(defn handle-known-ops-or-delegate! [nrepl-message next-handler]
  (case (:op nrepl-message)
    "identify-dirac-nrepl-middleware" (handle-identify-dirac-nrepl-middleware! next-handler nrepl-message)
    "finish-dirac-job" (handle-finish-dirac-job! nrepl-message)
    "eval" (handle-eval! next-handler nrepl-message)
    "load-file" (handle-load-file! next-handler nrepl-message)
    (next-handler nrepl-message)))

(defn handle-normal-message! [nrepl-message next-handler]
  (let [{:keys [session] :as nrepl-message} (wrap-nrepl-message-if-observed nrepl-message)]
    (cond
      (sessions/joined-session? session) (forward-message-to-joined-session! nrepl-message)
      :else (handle-known-ops-or-delegate! nrepl-message next-handler))))

(defn dirac-nrepl-middleware-handler [next-handler nrepl-message]
  (state/ensure-session nrepl-message
    (let [nrepl-message (logged-nrepl-message nrepl-message)]
      (log/debug "dirac-nrepl-middleware:" (:op nrepl-message) (sessions/get-session-id (:session nrepl-message)))
      (log/trace "received nrepl message:\n" (debug/pprint-nrepl-message nrepl-message))
      (debug/log-stack-trace!)
      (cond
        (dirac-special-command? nrepl-message) (handle-dirac-special-command! nrepl-message)
        (is-eval-cljs-quit-in-joined-session? nrepl-message) (issue-dirac-special-command! nrepl-message ":disjoin")
        :else (handle-normal-message! nrepl-message next-handler)))))

(defn dirac-nrepl-middleware [next-handler]
  (partial dirac-nrepl-middleware-handler next-handler))

; -- additional tools -------------------------------------------------------------------------------------------------------

; this message is sent to client after booting into a Dirac REPL
(defn send-bootstrap-info! [weasel-url]
  (assert (state/has-session?))                                                                                               ; we asssume this code is running within ensure-session
  (debug/log-stack-trace!)
  (let [nrepl-message (state/get-nrepl-message)]
    (log/trace "send-bootstrap-info!" weasel-url "\n" (debug/pprint-nrepl-message nrepl-message))
    (let [info-message {:op         :bootstrap-info
                        :weasel-url weasel-url}]
      (log/debug "sending :bootstrap-info" info-message)
      (send-response! nrepl-message info-message))))

(defn weasel-server-started! [weasel-url runtime-tag]
  (assert weasel-url)
  (assert (state/has-session?))                                                                                               ; we asssume this code is running within ensure-session
  (debug/log-stack-trace!)
  (let [{:keys [session transport]} (state/get-nrepl-message)]
    (sessions/add-dirac-session-descriptor! session transport runtime-tag)
    (send-bootstrap-info! weasel-url)))
