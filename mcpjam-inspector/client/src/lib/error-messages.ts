/**
 * User-facing error copy for Inspector. Edit wording here, not at call sites.
 * Keep messages specific about what failed and how the user can recover.
 * Backend messages and diagnostic details must never be added dynamically.
 */
export const ERROR_MESSAGES = {
  environmentModelRequired: "A selected client has no model. Pick a model in Models and deselect Client defaults, or set a model on the client.",
  environmentUnavailableSelection: "One of the selected environments is no longer available. Remove it and pick another.",
  personaGenerationInterrupted: "Persona generation was interrupted when this view reloaded. Nothing was saved. Press Continue to generate again.",
  upstreamUnavailable: "MCPJam was briefly unreachable. Nothing in this chat was lost. Retry to send your message again.",
  unknownErrorTitle: "This action couldn’t finish",
  chatFailed:
    "We couldn’t finish this response. Try sending your message again.",
  rateLimited:
    "Too many requests are being processed right now. Wait a moment, then try again.",
  quickSetupUnavailable:
    "This workspace doesn’t support quick setups yet. Pick a saved environment instead.",
  serverAlreadyConnected:
    "This server is already connected to a different address. Disconnect it before changing its address.",
  unexpected: "We couldn’t complete that action. Please try again.",
  pageTitle: "This page couldn’t load",
  pageLoad: "We couldn’t load this page. Reload it to try again.",
  connectionFailed:
    "We couldn’t connect to the server. Check that it is running and that its connection settings are correct, then reconnect.",
  protocolVersionUnsupported:
    "This server doesn’t support the selected MCP protocol version. Choose a supported version in the client’s MCP Protocol settings, then reconnect.",
  signInRequired: "Sign in to continue, then try again.",
  accessDenied:
    "You don’t have access to this item, or it no longer exists. Ask a project member to check your access.",
  environmentNoServers:
    "This environment has no servers available for this run. Connect a server and check that it is reachable from where you are running the test.",
  environmentArchived:
    "This environment is archived. Restore it or choose another environment.",
  environmentHostMissing:
    "This environment’s client was deleted. Choose another client in the environment settings.",
  environmentAttachmentMissing:
    "This environment’s server group was deleted. Choose another server group in the environment settings.",
  environmentUnavailable:
    "This environment couldn’t start. Check its client and server settings, then try again.",
  organizationRequired:
    "Choose an organization for this item before continuing.",
  githubUnavailable:
    "GitHub Checks settings are unavailable right now. Try again later.",
  githubRepositoryAccess:
    "The MCPJam GitHub App can’t access this repository. Grant it access on GitHub, then reconnect the repository.",
  githubUnreachable: "We couldn’t reach GitHub. Please try again.",
  githubAdminRequired:
    "Ask an organization admin to update these GitHub settings.",
  githubSaveFailed:
    "We couldn’t save your GitHub Checks settings. Please try again.",
  githubCommentsFailed:
    "We couldn’t update pull-request comments. Refresh to check the current setting before trying again.",

  // Operation-specific messages, shared by toast and inline error surfaces.
  thatClientNoLongerExistsItMayHaveBeenDeleted:
    "That client no longer exists. It may have been deleted.",
  couldnTOpenThatClient: "Couldn't open that client",
  couldNotCopyOauthDebuggerError: "Could not copy OAuth debugger error",
  checkoutIsnTAvailableInThisEnvironment:
    "Checkout isn't available in this environment.",
  couldNotStartSignInTryAgain: "Could not start sign in. Try again.",
  createOrJoinAnOrganizationToContinueWithCheckout:
    "Create or join an organization to continue with checkout.",
  couldNotUpdatePlanTryAgain: "Could not update plan. Try again.",
  failedToSyncChatHistoryTryAgain: "Failed to sync chat history. Try again.",
  failedToLoadChatHistory: "Failed to load chat history.",
  couldnTApplyThatEditTryAgain: "Couldn't apply that edit. Try again.",
  failedToDeleteSuite: "Failed to delete suite",
  failedToDeleteRun: "Failed to delete run",
  selectOrCreateAProjectBeforeRunningTheQuickstart:
    "Select or create a project before running the quickstart.",
  suiteCreatedButAttachingItsEnvironmentsFailed:
    "Suite created, but attaching its environments failed",
  failedToCreateSuite: "Failed to create suite",
  failedToAdvanceTheOauthFlow: "Failed to advance the OAuth flow",
  failedToLeaveOrganization: "Failed to leave organization",
  pleaseSelectAnImageFile: "Please select an image file",
  imageMustBeLessThan5mb: "Image must be less than 5MB",
  failedToUploadLogoPleaseTryAgain: "Failed to upload logo. Please try again.",
  upgradeRequiredToAddMoreMembers: "Upgrade required to add more members",
  failedToInviteMember: "Failed to invite member",
  paymentWasNotCompletedTheMemberWasNotAdded:
    "Payment was not completed. The member was not added.",
  stripeCouldNotConfirmCancellationYetThePaymentIsStillPendingTry:
    "Stripe could not confirm cancellation yet. The payment is still pending; try again.",
  thisSeatPaymentIsNoLongerActive: "This seat payment is no longer active.",
  failedToCancelPendingSeatPayment: "Failed to cancel pending seat payment",
  couldNotRemoveThisMemberPleaseTryAgain:
    "Could not remove this member. Please try again.",
  failedToUpdateMemberRole: "Failed to update member role",
  failedToTransferOrganizationOwnership:
    "Failed to transfer organization ownership",
  failedToDeleteOrganization: "Failed to delete organization",
  failedToOpenBillingPortal: "Failed to open billing portal",
  failedToOpenBillingIntervalChange: "Failed to open billing interval change",
  failedToCancelScheduledBillingChange:
    "Failed to cancel scheduled billing change",
  failedToChangePlan: "Failed to change plan",
  enterYourName: "Enter your name.",
  couldNotSaveYourChangesPleaseTryAgain:
    "Could not save your changes. Please try again.",
  enterBothASubjectAndAnEmailOrClearBothFields:
    "Enter both a subject and an email, or clear both fields.",
  connectThisServerBeforeRunningPrompts:
    "Connect this server before running prompts.",
  couldNotDisconnectThisServer: "Could not disconnect this server.",
  couldNotRemoveThisEntry: "Could not remove this entry.",
  connectThisServerBeforeReadingResources:
    "Connect this server before reading resources.",
  appIsStillLoadingTryAgainInAMoment:
    "App is still loading. Try again in a moment.",
  serverAddedButSavingItsProtocolVersionFailed:
    "Server added, but saving its protocol version failed.",
  upgradeRequiredToAddMoreServers: "Upgrade required to add more servers",
  failedToFetchTasks: "Failed to fetch tasks",
  failedToRespondToElicitation:
    "We couldn’t send your response to the server’s request. Please try again.",
  failedToFetchTaskResult: "Failed to fetch task result",
  failedToCancelTask: "Failed to cancel task",
  failedToSubmitTaskInput: "Failed to submit task input",
  thisToolRequiresTaskExecutionAndTasksAreDisabledByTheHost:
    "This tool requires task execution, and tasks are disabled by the host configuration.",
  connectThisServerBeforeRunningTools:
    "Connect this server before running tools.",
  enter5001000000WholeCreditsPerRefillAndAMinimum:
    "Enter 500–1,000,000 whole credits per refill and a minimum balance from 1 through the refill size.",
  enterAPositiveDollarLimitWithAtMostTwoDecimalPlacesOr:
    "Enter a positive dollar limit with at most two decimal places, or leave it blank for unlimited.",
  maximumMonthlySpendMustCoverAtLeastOneRefill:
    "Maximum monthly spend must cover at least one refill.",
  couldNotSaveTheBrowserProfile: "Could not save the browser profile.",
  couldNotLoadBrowserProfiles: "Could not load browser profiles.",
  couldNotSelectThatProfile: "Could not select that profile.",
  couldNotDeleteThatProfile: "Could not delete that profile.",
  someoneElseHasControlOfThisBrowser:
    "Someone else has control of this browser.",
  thisBrowserIsNoLongerRunning: "This browser is no longer running.",
  theBrowserCouldNotCompleteThatActionTryAgain:
    "The browser could not complete that action. Try again.",
  couldNotReachThisBrowserTryAgain: "Could not reach this browser. Try again.",
  someoneElseIsUsingThisBrowserRightNow:
    "Someone else is using this browser right now.",
  somebodyElseHasTakenControlOfThisBrowserTheViewWillResume:
    "Somebody else has taken control of this browser. The view will resume when they hand it back.",
  thisMachineSAuthorizationChangedReopenThePaneToWatchAgain:
    "This machine's authorization changed. Reopen the pane to watch again.",
  couldnTFinishBrowserSetupTryAgain:
    "Couldn't finish Browser setup. Try again.",
  failedToLoadFiles: "Failed to load files",
  noSkillMdFileFoundSkillsMustContainASkillMdFile:
    "No SKILL.md file found. Skills must contain a SKILL.md file.",
  invalidSkillMdFormatMustContainFrontmatterWithNameAndDescriptionFields:
    "Invalid SKILL.md format. Must contain frontmatter with 'name' and 'description' fields.",
  failedToReadSkillMdFile: "Failed to read SKILL.md file.",
  unknownError: "We couldn’t complete that action. Please try again.",
  voiceTranscriptionFailed: "Voice transcription failed.",
  voiceInputIsNotSupportedInThisBrowser:
    "Voice input is not supported in this browser.",
  youVeUsedTodaySVoiceBudget: "You've used today's voice budget.",
  voiceInputRecordingFailedTryAgain: "Voice input recording failed. Try again.",
  couldNotStartVoiceInput: "Could not start voice input.",
  couldNotStopVoiceInput: "Could not stop voice input.",
  failedToPromoteSession:
    "We couldn’t save this session as a reusable conversation. Please try again.",
  failedToSaveAsTestCase: "Failed to save as test case",
  couldNotCopyToClipboard: "Could not copy to clipboard",
  toolRequiresElicitationNotSupportedHere:
    "Tool requires elicitation (not supported here)",
  backgroundTasksAreNotSupportedHere: "Background tasks are not supported here",
  executionFailed:
    "The run couldn’t finish. Check the run details, then try again.",
  valueMustBeAJsonObject: "Value must be a JSON object",
  invalidJson: "Invalid JSON",
  mustBeAJsonObject: "Must be a JSON object",
  couldNotLoadLiveClientTemplates: "Could not load live client templates",
  noBrowserIsRunningOnThisComputerYet:
    "No browser is running on this computer yet.",
  couldNotReachTheBrowser: "Could not reach the browser.",
  couldNotChangeControlOfTheBrowser: "Could not change control of the browser.",
  connectTheTerminalFirstThenDropFiles:
    "Connect the terminal first, then drop files.",
  uploadFailed: "Upload failed.",
  couldNotStartTheComputer: "Could not start the computer.",
  couldNotDeleteTheComputer: "Could not delete the computer.",
  couldNotHibernateTheComputer: "Could not hibernate the computer.",
  couldNotResetTheComputer: "Could not reset the computer.",
  dailyComputerStartLimitReached: "Daily computer start limit reached.",
  couldNotSwitchToTheBaseImage: "Could not switch to the base image.",
  giveTheSandboxImageAName: "Give the sandbox image a name.",
  couldNotCreateTheSandboxImage: "Could not create the sandbox image.",
  couldNotSave: "Could not save.",
  couldNotStartTheBuild: "Could not start the build.",
  couldNotUseThisSandboxImage: "Could not use this sandbox image.",
  onlyProjectAdminsCanShareSandboxImages:
    "Only project admins can share sandbox images.",
  onlyProjectAdminsCanDeleteSharedSandboxImages:
    "Only project admins can delete shared sandbox images.",
  couldNotUpdateSharing: "Could not update sharing",
  serverSecretsCanOnlyBeRevealedAfterSaving:
    "Server secrets can only be revealed after saving.",
  couldnTRevealSavedSecretsTryAgainOrReSaveThisServer:
    "Couldn't reveal saved secrets. Try again, or re-save this server's env vars/headers.",
  pleaseSelectAValidJsonFile: "Please select a valid JSON file",
  pleaseFixTheJsonValidationErrorsBeforeImporting:
    "Please fix the JSON validation errors before importing",
  noValidServersFoundInTheJsonConfig:
    "No valid servers found in the JSON config",
  signInToCreateTunnels: "Sign in to create tunnels",
  httpServersAreNotSupportedInHostedMode:
    "HTTP servers are not supported in hosted mode",
  thisServerUsesCredentialsThatCanTBeSharedOrganizationEntriesCarry:
    "This server uses credentials that can't be shared. Organization entries carry only the address and how to sign in.",
  wireModeOverrideRequiresAProjectContextCannotSaveWithoutProjectid:
    "Wire mode override requires a project context; cannot save without projectId.",
  projectConfigurationIsStillLoadingTryAgainInAMoment:
    "Project configuration is still loading. Try again in a moment.",
  failedToUpdateWireModeOverride: "Failed to update wire mode override",
  failedToLoadToolsMetadata: "Failed to load tools metadata",
  revealSavedHeadersBeforeChangingAuthenticationSoExistingHiddenHeadersArenT:
    "Reveal saved headers before changing authentication so existing hidden headers aren't lost.",
  couldnTLoadThisServerSSavedHeadersToApplyThisChange:
    "Couldn't load this server's saved headers to apply this change. Reveal saved headers in Advanced settings and try again.",
  failedToRevealHostedOauthTokens: "Failed to reveal hosted OAuth tokens",
  failedToLoadMessages: "Failed to load messages",
  failedToCopy: "Failed to copy",
  failedToRevealClientSecret: "Failed to reveal client secret",
  copyFailed: "Copy failed",
  thePreviewCouldNotRun: "The preview could not run",
  couldNotCopy: "Could not copy",
  couldNotResolveWhereThisSuiteRuns: "Could not resolve where this suite runs.",
  failedToDeleteTestCase: "Failed to delete test case",
  failedToLoadBlob:
    "We couldn’t load the saved run details. Refresh the page to try again.",
  waitAMinuteBeforeRunningAnotherBacktest:
    "Wait a minute before running another backtest.",
  theBacktestCouldNotRun: "The backtest could not run.",
  couldNotAcknowledgeTheJudgeGate: "Could not acknowledge the judge gate",
  failedToDeleteSomeRuns: "Failed to delete some runs",
  pickWhichEnvironmentScheduledRunsShouldUseBeforeEnabling:
    "Pick which environment scheduled runs should use before enabling.",
  failedToUpdateSchedule: "Failed to update schedule",
  failedToCreateApiKeyPleaseTryAgain:
    "Failed to create API key. Please try again.",
  failedToUpdateTheSchedule: "Failed to update the schedule",
  failedToUpdateClients: "Failed to update clients",
  failedToUpdateWhereThisRuns: "Failed to update where this runs",
  failedToUpdateTheSuite: "Failed to update the suite",
  failedToUpdateSuiteExecutionConfig: "Failed to update suite execution config",
  failedToResetSuiteToProjectDefault:
    "Failed to reset suite to project default",
  failedToUpdateSuiteName: "Failed to update suite name",
  thisSuiteChangedSinceYouOpenedItYourEditsAreStillHere:
    "This suite changed since you opened it. Your edits are still here. Review them against the new values and save again.",
  failedToUpdateServerGroup: "Failed to update server group",
  failedToUpdateEnvironments: "Failed to update environments",
  failedToDeleteTestCases: "Failed to delete test cases",
  fixTheTestConfigurationBeforeSaving:
    "Fix the test configuration before saving.",
  failedToCreateTestCase: "Failed to create test case",
  failedToSaveChanges: "Failed to save changes",
  failedToSaveEvaluatorChanges: "Failed to save evaluator changes",
  selectAtLeastOneModelToRun: "Select at least one model to run.",
  fixTheTestConfigurationBeforeRunning:
    "Fix the test configuration before running.",
  noMcpServersAreConfiguredForThisSuite:
    "No MCP servers are configured for this suite.",
  failedToSaveTestCaseBeforeRunning: "Failed to save test case before running",
  failedToPrepareCompareRun: "Failed to prepare compare run",
  failedToRunModel: "Failed to run model",
  compareRunFailedForAllSelectedModels:
    "Compare run failed for all selected models.",
  failedToClearLatestResult: "Failed to clear latest result",
  couldNotUndoEdit: "Could not undo edit",
  noTestCasesFoundInThisSuite: "No test cases found in this suite",
  noTestsToRunTheSuiteSRenderChecksAreMissingTheir:
    "No tests to run. The suite's render checks are missing their configuration.",
  noTestsToRunPleaseAddModelsToYourTestCases:
    "No tests to run. Please add models to your test cases.",
  thisCiRunCanTBeReplayedBecauseItDoesnTHave:
    "This CI run can't be replayed because it doesn't have stored replay config.",
  failedToReplayEvalRun: "Failed to replay eval run",
  attachAClientToThisSuiteBeforeRunningIt:
    "Attach a client to this suite before running it.",
  thatCaseIsNotInThisSuite: "That case is not in this suite.",
  failedToStartEvalRun: "Failed to start eval run",
  addAModelFirst: "Add a model first",
  failedToRunTestCase: "Failed to run test case",
  failedToDeleteTestSuite: "Failed to delete test suite",
  failedToDuplicateTestSuite: "Failed to duplicate test suite",
  failedToCancelRun: "Failed to cancel run",
  failedToDuplicateTestCase: "Failed to duplicate test case",
  addAtLeastOneServerToThisSuiteBeforeGeneratingCases:
    "Add at least one server to this suite before generating cases.",
  failedToGenerateTestCases: "Failed to generate test cases",
  failedToLoadTrace: "Failed to load trace",
  failedToSaveSettings: "Failed to save settings",
  chooseOneMarkdownFile: "Choose one Markdown file.",
  onlyMarkdownMdFilesAreSupported: "Only Markdown (.md) files are supported.",
  theFileIsEmpty: "The file is empty.",
  splitTheFileIntoDocumentsOfAtMost100Kb:
    "Split the file into documents of at most 100 KB.",
  noTestCasesWereExtractedReviewTheWarningsOrChooseAnotherFile:
    "No test cases were extracted. Review the warnings or choose another file.",
  couldNotReadOrExtractThisFile: "Could not read or extract this file.",
  couldNotStartPreparationTryAgain: "Could not start preparation. Try again.",
  couldNotSaveYourReviewReloadBeforeContinuing:
    "Could not save your review. Reload before continuing.",
  couldNotReconnectCheckTheServerConnectionAndTryAgain:
    "Could not reconnect. Check the server connection and try again.",
  couldNotStartPreparation: "Could not start preparation.",
  couldNotStartEvaluations: "Could not start evaluations.",
  couldNotStartThisRunTryAgain: "Could not start this run. Try again.",
  chooseAFolderForClaudeCodeToWorkInBeforeAllowingIt:
    "Choose a folder for Claude Code to work in before allowing it.",
  chooseAFolderForClaudeCodeToWorkIn:
    "Choose a folder for Claude Code to work in.",
  thatFolderCouldNotBeRegistered: "That folder could not be registered.",
  selectAProjectBeforeCreatingAClient:
    "Select a project before creating a client.",
  couldNotLoadLiveClientTemplates2: "Could not load live client templates.",
  selectAProjectBeforeConnectingAServer:
    "Select a project before connecting a server.",
  linkUnavailable: "Link unavailable",
  copyIsNotAvailableInThisBrowser: "Copy is not available in this browser",
  failedToCopyLink: "Failed to copy link",
  failedToCreateClient: "Failed to create client",
  failedToDuplicateClient: "Failed to duplicate client",
  fixValidationErrorsBeforeSaving: "Fix validation errors before saving",
  failedToSaveClient: "Failed to save client",
  failedToAddServer: "Failed to add server",
  couldNotLoadSavedBrowserProfiles: "Could not load saved browser profiles.",
  couldnTCopyToClipboard: "Couldn't copy to clipboard",
  stillLoadingThisProjectSServerGroups:
    "Still loading this project's server groups.",
  stillSavingTheLastChangeTryAgainInAMoment:
    "Still saving the last change. Try again in a moment.",
  pickADifferentServerFirstThisOneIsInUseHere:
    "Pick a different server first: this one is in use here.",
  couldnTDeleteThatServerGroup: "Couldn't delete that server group.",
  failedToCopyLogs: "Failed to copy logs",
  failedToUpdate: "Failed to update",
  couldNotCreateTestsTryAgain: "Could not create tests. Try again.",
  serverUrlIsRequired: "Server URL is required",
  enterAValidMcpBaseUrlEGHttpsExampleCom:
    "Enter a valid MCP base URL (e.g., https://example.com)",
  serverNameIsRequired: "Server name is required",
  couldNotSaveTheServerPleaseTryAgain:
    "Could not save the server. Please try again.",
  failedToCreateOrganization: "Failed to create organization",
  couldNotSendInvitationPleaseTryAgain:
    "Could not send invitation. Please try again.",
  thisPlanOrBillingIntervalIsNotOfferedToThisOrganization:
    "This plan or billing interval is not offered to this organization.",
  onlyOrganizationOwnersCanStartCheckout:
    "Only organization owners can start checkout.",
  enterAnOrganizationName: "Enter an organization name.",
  couldNotSaveTheOrganizationNamePleaseTryAgain:
    "Could not save the organization name. Please try again.",
  failedToRemoveProvider: "Failed to remove provider",
  failedToSaveProvider: "Failed to save provider",
  failedToSaveCustomProvider: "Failed to save custom provider",
  providerNameIsRequired: "Provider name is required",
  providerNameCannotContainOr: "Provider name cannot contain '/' or ':'",
  baseUrlIsRequired: "Base URL is required",
  atLeastOneModelNameIsRequired: "At least one model name is required",
  pickAtLeastOneSourceOrTheDestinationSendsNothing:
    "Pick at least one source, or the destination sends nothing.",
  pickAtLeastOneProjectOrChooseAllProjects:
    "Pick at least one project, or choose all projects.",
  enterAProjectName: "Enter a project name.",
  couldNotSaveProjectDetailsPleaseTryAgain:
    "Could not save project details. Please try again.",
  failedToDeleteTheSecret: "Failed to delete the secret.",
  addTheHostsAndHeaderThisSecretIsSentWithOrChoose:
    'Add the hosts and header this secret is sent with, or choose "Set as an environment variable" under Advanced settings.',
  failedToCreateTheSecret: "Failed to create the secret.",
  failedToRotateTheSecret: "Failed to rotate the secret.",
  failedToUpdateProjectVisibility: "Failed to update project visibility",
  failedToUpdateRole: "Failed to update role",
  failedToRemoveMember: "Failed to remove member",
  failedToSaveTheEnvironment: "Failed to save the environment.",
  giveTheEnvironmentAName: "Give the environment a name.",
  pickAClientForThisEnvironment: "Pick a client for this environment.",
  thisEnvironmentWasChangedBySomeoneElseReviewTheRefreshedValuesBefore:
    "This environment was changed by someone else. Review the refreshed values before saving again.",
  couldNotSaveTheEnvironment: "Could not save the environment.",
  couldNotCreateTheEnvironment: "Could not create the environment.",
  failedToLoadSkills: "Failed to load skills",
  couldNotArchiveTheEnvironment: "Could not archive the environment.",
  couldNotRestoreTheEnvironment: "Could not restore the environment.",
  chooseAnEndpointToContinue: "Choose an endpoint to continue.",
  enterYourInstanceUrlToContinue: "Enter your instance URL to continue.",
  aConnectorUrlMustStartWithHttpOrHttps:
    "A connector URL must start with http:// or https://.",
  thatDoesNotLookLikeAValidInstanceUrlForThisConnector:
    "That does not look like a valid instance URL for this connector.",
  checkTheServerBeforeAddingItToTheRegistry:
    "Check the server before adding it to the registry.",
  failedToUpdateThePerTurnRatingsSetting:
    "Failed to update the per-turn ratings setting",
  failedToUpdateTheRatingWidgetStyle:
    "Failed to update the rating widget style",
  failedToCopyShareLink: "Failed to copy share link",
  failedToInvite: "Failed to invite",
  failedToSaveTasks: "Failed to save tasks",
  thisClientAndServerAlreadyHaveAStudyOnThisDeploymentChange:
    "This client and server already have a study on this deployment. Change the setup, or open the existing study from User Testing.",
  studyCreatedButItsRatingsAndTaskListDidnTSaveSet:
    "Study created, but its ratings and task list didn't save. Set them from the study's settings.",
  failedToCreateTheStudy: "Failed to create the study",
  couldNotResolveThisSetupToAnEnvironment:
    "Could not resolve this setup to an environment.",
  thisWorkspaceSBackendDoesnTSupportEditingAScenarioSSetup:
    "This workspace's backend doesn't support editing a scenario's setup yet.",
  couldNotUpdateThisScenarioSSetup: "Could not update this scenario's setup",
  failedToRenameTheScenario: "Failed to rename the scenario",
  failedToSaveTheDescription: "Failed to save the description",
  failedToDeleteTheScenario: "Failed to delete the scenario",
  enterAValidHttpSMcpServerUrl: "Enter a valid http(s) MCP server URL.",
  scanFinishedButTheShareableLinkCouldNotBeSaved:
    "Scan finished, but the shareable link could not be saved.",
  couldNotCopyTheLinkCopyItManually:
    "Could not copy the link. Copy it manually.",
  apiUrlIsRequired: "API URL is required",
  pickARepositoryASuiteAndAnOutagePolicyFirst:
    "Pick a repository, a suite, and an outage policy first.",
  failedToUpdateAccessSettings: "Failed to update access settings",
  failedToRotateLink: "Failed to rotate link",
  failedToRevokeAccess: "Failed to revoke access",
  enterYourRoleToContinue: "Enter your role to continue.",
  couldNotSaveYourOccupationPleaseTryAgain:
    "Could not save your occupation. Please try again.",
  failedToUpdatePersona: "Failed to update persona",
  failedToDeletePersona: "Failed to delete persona",
  failedToCreatePersona: "Failed to create persona",
  couldNotCreateTheGoal: "Could not create the goal",
  failedToStartRun: "Failed to start run",
  failedToUpdateGrading: "Failed to update grading",
  pickAtLeastOneEnvironmentThatResolvesToAValidClient:
    "Pick at least one environment that resolves to a valid client.",
  couldnTSaveThisPersonaYourChangesAreStillHere:
    "Couldn't save this persona. Your changes are still here.",
  couldNotCopyLink: "Could not copy link",
  couldNotStartSwarmRun: "Could not start swarm run",
  couldNotStopTheRun: "Could not stop the run",
  couldNotSaveDraftOnThisDevice: "Could not save draft on this device.",
  transcriptBlobHadNoMessages: "Transcript blob had no messages",
  failedToLoadTranscript: "Failed to load transcript",
  youNoLongerHaveAccessToThatChat: "You no longer have access to that chat.",
  thisInspectorCanTRunClaudeCodeOnThisMachine:
    "This Inspector can't run Claude Code on this machine.",
  couldNotUploadAttachmentsToTheComputer:
    "Could not upload attachments to the computer.",
  couldnTPrepareTheServerForThatEditTryAgain:
    "Couldn't prepare the server for that edit. Try again.",
  failedToFetchTools: "Failed to fetch tools",
  inputMustBeAJsonObject: "Input must be a JSON object.",
  invalidJson2: "Invalid JSON.",
  couldNotCopyActivityToYourClipboard:
    "Could not copy activity to your clipboard",
  couldNotClearInspectionSiteData: "Could not clear inspection site data",
  couldnTSaveThisIdentity: "Couldn't save this identity",
  couldnTDeleteThisIdentity: "Couldn't delete this identity",
  serverNameIsRequired2: "Server name is required.",
  serverUrlIsRequired2: "Server URL is required.",
  enterAValidServerUrlEGHttpsStagingExampleCom:
    "Enter a valid server URL (e.g. Https://staging.example.com).",
  clientIdIsRequiredForPreRegisteredClients:
    "Client ID is required for pre-registered clients.",
  authorizationServerIssuerMustBeAValidUrlOrBlank:
    "Authorization Server Issuer must be a valid URL, or blank.",
  couldnTSaveThisServerYourChangesWereKeptTryAgain:
    "Couldn't save this server. Your changes were kept. Try again.",
  projectNotFound: "Project not found",
  cannotLeaveTheOnlyProject: "Cannot leave the only project",
  authorizationIsRequiredButThisConversationCannotBeResumedAutomaticallyAuthorizeThen:
    "Authorization is required, but this conversation cannot be resumed automatically. Authorize, then retry the tool.",
  thatToolCallWasInterruptedAndMayOrMayNotHaveRun:
    "That tool call was interrupted and may or may not have run. Check the server before retrying.",
  authorizationWasCancelledButTheSuspendedToolCallCouldNotBeUpdated:
    "Authorization was cancelled, but the suspended tool call could not be updated.",
  theAuthorizedToolCallCouldNotBeResumedSafelyCheckWhetherIt:
    "The authorized tool call could not be resumed safely. Check whether it ran before retrying manually.",
  thisChatNoLongerHasTheToolCallThatNeededInputSo:
    "This chat no longer has the tool call that needed input, so the operation was cancelled.",
  theChatTargetChangedWhileThisMessageWasBeingPreparedSendIt:
    "The chat target changed while this message was being prepared. Send it again to run it against the current selection.",
  theChatChangedWhileThisMessageWasBeingPreparedSendItAgain:
    "The chat changed while this message was being prepared. Send it again to run it in the current thread.",
  couldnTPrepareTheSelectedServersForThisRun:
    "Couldn't prepare the selected servers for this run.",
  couldnTReturnBrowserControl: "Couldn't return browser control.",
  couldnTSendYourResponseTheRequestWillTimeOut:
    "Couldn't send your response. The request will time out.",
  thisEnvironmentCouldnTBeResolved: "This environment couldn't be resolved.",
  couldnTLoadThisEnvironmentSTools: "Couldn't load this environment's tools.",
  signInToViewModelMetadata: "Sign in to view model metadata",
  failedToConnectToExcalidraw: "Failed to connect to Excalidraw",
  someLocalProjectsCouldNotBeMigrated:
    "Some local projects could not be migrated",
  createOrJoinAnOrganizationToCreateProjects:
    "Create or join an organization to create projects.",
  failedToCreateProject: "Failed to create project",
  cannotDeleteTheOnlyProject: "Cannot delete the only project",
  failedToDuplicateProject: "Failed to duplicate project",
  failedToImportProject: "Failed to import project",
  couldNotSaveTheServerConfigurationPleaseTryAgain:
    "Could not save the server configuration. Please try again.",
  checkoutIsNotAvailableForThisPlanRightNow:
    "Checkout is not available for this plan right now.",
  couldnTStartCheckoutPleaseTryAgain:
    "Couldn't start checkout. Please try again.",
  failedToLoadApiKeys: "Failed to load API keys",
  creditsAddedButWeCouldnTResendYourLastMessagePleaseSend:
    "Credits added, but we couldn't resend your last message. Please send it again.",
  rebuildFailedTryAgainInAFewMinutes:
    "Rebuild failed. Try again in a few minutes.",
  couldNotMergeGuestStars: "Could not merge guest stars",
  automaticUpdateIsnTWorkingOnThisInstallDownloadTheNewVersion:
    "Automatic update isn't working on this install. Download the new version instead.",
  updateFailedTryAgainLater: "Update failed. Try again later.",
  theBrowserDidNotAcceptThat: "The browser did not accept that.",
  couldNotHandTheBrowserBack: "Could not hand the browser back.",
  couldNotConnectToTheExcalidrawServerInTimeTryAgainIn:
    "Could not connect to the Excalidraw server in time. Try again in a moment.",
  couldNotPrepareTheExcalidrawQuickstartTryAgain:
    "Could not prepare the Excalidraw quickstart. Try again.",
  couldNotCreateTheExcalidrawQuickstartTryAgain:
    "Could not create the Excalidraw quickstart. Try again.",
  couldNotCopyTheDiagnosticsToYourClipboard:
    "Could not copy the diagnostics to your clipboard",

  // Shared error screens and domain recovery guidance.
  connectedBeforeMcpjamVerifiedRepositoriesReconnectItToKeepChecks:
    "Connected before MCPJam verified repositories. Reconnect it to keep checks running. Nothing is wrong with the repository or its pull requests.",
  theMcpjamGithubAppIsNotActiveOnThisAccount:
    "The MCPJam GitHub App is not active on this account right now, so checks are paused. This is not a problem with your pull requests. Reconnect the app from the section above.",
  theMcpjamGithubAppNoLongerHasAccessToThis:
    "The MCPJam GitHub App no longer has access to this repository, so checks are paused. This is not a problem with your pull requests. Grant it access on GitHub, then reconnect.",
  reconnectRequired: "Reconnect required",
  appInactive: "App inactive",
  noAccess: "No access",
  connectedRepositoriesOnThisAccountCanRunChecks:
    "Connected. Repositories on this account can run checks.",
  suspendedOnGithubChecksArePausedForThisAccountUntil:
    "Suspended on GitHub. Checks are paused for this account until somebody unsuspends the app there.",
  theAppWasUninstalledFromThisAccountReconnectItTo:
    "The app was uninstalled from this account. Reconnect it to start running checks again.",
  disconnectedFromThisWorkspace: "Disconnected from this workspace.",
  disconnectThisGithubAccountChecksOnItsRepositoriesStopImmediately:
    "Disconnect this GitHub account? Checks on its repositories stop immediately. Your suite and policy settings are kept, so reconnecting restores them.",
  weCouldNotFinishConnectingThatGithubAccountThisIs:
    "We could not finish connecting that GitHub account. This is not a problem with your repositories. Start again from Settings.",
  mcpjamWillCommentOnPullRequestsInThisRepository:
    "MCPJam will comment on pull requests in this repository.",
  mcpjamWillStopCommentingOnPullRequestsInThisRepository:
    "MCPJam will stop commenting on pull requests in this repository. This setting does not change whether the check itself runs.",
  thisPageFinishesConnectingAGithubAccountAndItWas:
    "This page finishes connecting a GitHub account, and it was opened without the details GitHub sends. Start again from Settings.",
  youAreNotSignedInToMcpjamSoWeCould:
    "You are not signed in to MCPJam, so we could not finish connecting that GitHub account. Sign in and start again from Settings.",
  thisEnvironmentHasNoServersToRunAgainst:
    "This environment has no servers to run against",
  theClientThisEnvironmentPointsAtHasNoServersConnected:
    "The client this environment points at has no servers connected",
  theAttachedServerGroupIsEmpty: "The attached server group is empty",
  everyServerContributedByAPinnedPluginHasBeenRemoved:
    "Every server contributed by a pinned plugin has been removed",
  theOnlyServersAreLocalStdioOrALocalhostPrivate:
    "Cloud runs can’t reach servers that use stdio, localhost, or a private address",
  connectAServerToTheClientOrAttachAServer:
    "Connect a server to the client, or attach a server group",
  forALocalServerExposeItOverHttpsCreateTunnel:
    "For a local server, expose it over HTTPS (Create tunnel on its card) and point the client at that URL, or run this from a local surface instead",
  checkTheEnvironmentSPinnedPluginsIfItReliedOn:
    "Check the environment's pinned plugins if it relied on one for servers",
  thisEnvironmentIsArchived: "This environment is archived",
  someoneArchivedItAfterThisWasConfigured:
    "Someone archived it after this was configured",
  restoreItFromTheEnvironmentsListOrPickADifferent:
    "Restore it from the Environments list, or pick a different one",
  thisEnvironmentSClientNoLongerExists:
    "This environment's client no longer exists",
  theClientWasDeletedAfterTheEnvironmentWasCreated:
    "The client was deleted after the environment was created",
  pointTheEnvironmentAtADifferentClientOrRecreateIt:
    "Point the environment at a different client, or recreate it",
  thisEnvironmentSServerGroupIsGone: "This environment's server group is gone",
  theAttachedServerGroupWasDeleted: "The attached server group was deleted",
  attachADifferentServerGroupOrClearTheAttachment:
    "Attach a different server group, or clear the attachment",
  thisEnvironmentCanTRunRightNow: "This environment can't run right now",
  openTheEnvironmentAndCheckItsClientServersAndPins:
    "Open the environment and check its client, servers, and pins",
  connectionInterrupted: "Connection interrupted",
  weLostContactWithTheServerWhileLoadingThisTrace:
    "We lost contact with the server while loading this trace. Check your connection and try again.",
  couldnTLoadTrace: "Couldn't load trace",
  somethingWentWrongWhileLoadingTheRecordedTraceTryAgain:
    "Something went wrong while loading the recorded trace. Try again, or refresh the page if the problem continues.",
  runTimedOut: "Run timed out",
  theRunStoppedBeforeItCouldFinishRetryTheRun:
    "The run stopped before it could finish. Retry the run; if it happens again, check the execution limits and server response times.",
  theWorkerStoppedRespondingOrTheRunExceededItsTime:
    "The worker stopped responding or the run exceeded its time limit.",
  retryTheRun: "Retry the run.",
  checkTheRunSTimingAndConnectedServersIfIt:
    "Check the run's timing and connected servers if it times out again.",
  runSetupFailed: "Run setup failed",
  theExecutionEnvironmentCouldNotStartCheckTheHostS:
    "The execution environment could not start. Check the host's servers and configuration, then retry.",
  checkTheHostSServerConnectionsAndEnvironmentConfiguration:
    "Check the host's server connections and environment configuration.",
  runCancelled: "Run cancelled",
  theRunWasCancelledBeforeItFinished:
    "The run was cancelled before it finished.",
  startAnotherRunWhenYouAreReady: "Start another run when you are ready.",
  youDonTHaveAccessToThis: "You don't have access to this",
  itBelongsToAProjectYouReNotAMember:
    "It belongs to a project you're not a member of, or it no longer exists. ",
  ifSomeoneSharedThisLinkWithYouAskThemTo:
    "If someone shared this link with you, ask them to invite you to the project.",
  signInToContinue: "Sign in to continue",
  youReNotSignedInSoWeCanTTell:
    "You're not signed in, so we can't tell whether this is yours to see. ",
  signInAndYouLlComeStraightBackHere:
    "Sign in and you'll come straight back here.",
  authenticationError: "Your session couldn’t start",
  failedToEstablishSecureSession: "We couldn’t start your session.",
  thisIsUsuallyTemporaryRetryBelowAndCheckTheConsole:
    "Restart the app to try again. If the problem continues, contact support.",
  slackConnectIsnTAvailableRightNowOurTeamHas:
    "Slack Connect isn’t available right now. Try again later or contact support.",
  thisSlackWorkspaceHasReachedItsSlackConnectConnectionLimit:
    "This Slack workspace has reached its Slack Connect connection limit.",
  slackRejectedTheInviteEmail: "Slack rejected the invite email.",
  couldNotCreateAUniqueSharedChannelNameContactSupport:
    "Could not create a unique shared channel name. Contact support.",
  tooManySetupAttemptsContactSupportToFinishThisChannel:
    "Too many setup attempts. Contact support to finish this channel.",
  channelSetupIsAlreadyInProgressTryAgainInA:
    "Channel setup is already in progress. Try again in a few minutes.",
  slackConnectIsNotConfiguredOnThisDeployment:
    "Slack Connect is not configured on this deployment.",
  theSlackConnectInviteWasDeclinedFreeSlackWorkspacesCannot:
    "The Slack Connect invite was declined. Free Slack workspaces cannot accept Connect invites. Contact support if that isn't the case.",
  theSlackConnectInviteExpiredRequestANewOne:
    "The Slack Connect invite expired. Request a new one.",
  couldNotSetUpTheSharedSlackChannelTryAgain:
    "Could not set up the shared Slack channel. Try again.",
  sharedSlackChannel: "Shared Slack channel",
  slackConnectInviteSent: "Slack Connect invite sent",
  yourSharedSlackChannelIsReady: "Your shared Slack channel is ready",
  yourSharedSlackChannel: "Your shared Slack channel",

  // Local validation and operation failures.
  suiteWasCreatedWithoutAnId: "Suite was created without an id",
  attachServersBeforeGeneratingCases: "Attach servers before generating cases.",
  aRunIsAlreadyInProgressForThisSuite:
    "A run is already in progress for this suite.",
  runWasNotStartedCheckTheSuiteConfigurationAndUsage:
    "Run was not started. Check the suite configuration and usage allowance.",
  evalUsageIsUnavailableCheckYourUsageLimitBeforeRetrying:
    "Eval usage is unavailable. Check your usage limit before retrying.",
  someEvaluationsCouldNotStartRetryToLaunchTheRemaining:
    "Some evaluations could not start. Retry to launch the remaining clients.",
  failedToUploadFile: "Failed to upload file",
  paidPlanChangesRequireAnExplicitConfirmation:
    "Paid plan changes require an explicit confirmation.",
  theScenarioWasNotDeletedItMayAlreadyBeGone:
    "The scenario was not deleted, it may already be gone.",
  thisBrowserIsNotAttachedToAChatSessionYet:
    "This browser is not attached to a chat session yet.",
  noBrowserSelected: "No browser selected.",
  theHostedBrowserIsNotReadyYet: "The hosted browser is not ready yet.",
  openABrowserBeforeSavingItsProfile:
    "Open a browser before saving its profile.",
  failedToReadFileAsDataUrl: "Failed to read file as data URL",
  contextComponentsMustBeUsedWithinContext:
    "Context components must be used within Context",
  voiceTranscriptionTimedOutTryAShorterRecording:
    "Voice transcription timed out. Try a shorter recording.",
  anotherVoiceMessageIsStillProcessingTryAgainInA:
    "Another voice message is still processing. Try again in a moment.",
  failedToReadAudioData: "Failed to read audio data.",
  voiceTranscriptionReturnedAnEmptyTranscript:
    "Voice transcription returned an empty transcript.",
  noAudioWasCapturedTryRecordingAgain:
    "No audio was captured. Try recording again.",
  cannotShareASessionWithoutAProject:
    "Cannot share a session without a project.",
  resourceTemplatesAreNotSupportedInHostedMode:
    "Resource templates are not supported in hosted mode",
  thisSuitePinsASandboxImageButThisInspectorCan:
    "This suite pins a sandbox image, but this inspector can't run MCPJam cloud sandboxes.",
  thisRunReplaysFromItsPinnedSandboxImageButThis:
    "This run replays from its pinned sandbox image, but this inspector can't run MCPJam cloud sandboxes.",
  noProjectSelected: "No project selected.",
  storedHeadersMissingFromRevealResponse:
    "Stored headers missing from reveal response",
  clientCapabilitiesOverrideMustBeAJsonObject:
    "Client capabilities override must be a JSON object",
  oauthDebuggerE2eFlowDidNotReceiveAnAccessToken:
    "OAuth debugger e2e flow did not receive an access token",
  oauthDebuggerE2eFlowDidNotReceiveAClientId:
    "OAuth debugger e2e flow did not receive a client id",
  thePreviewReturnedAnUnsupportedResponse:
    "The preview returned an unsupported response",
  previewSourceChangedStartANewPreview:
    "Preview source changed; start a new preview",
  previewReturnedDuplicateEvidence: "Preview returned duplicate evidence",
  temperatureOverrideMustBeAValidNumber:
    "Temperature override must be a valid number",
  providerFlagsOverrideMustBeValidJson:
    "Provider flags override must be valid JSON",
  providerFlagsOverrideMustBeAJsonObject:
    "Provider flags override must be a JSON object",
  projectIsTooLargeToExportInOneFileExport:
    "Project is too large to export in one file. Export individual runs instead.",
  invalidModelSelection: "Invalid model selection",
  anAttachedClientIsUnavailableReloadTheSuiteAndTry:
    "An attached client is unavailable. Reload the suite and try again.",
  changeThisClientSPinnedPluginsInEnvironmentsBeforeAdding:
    "Change this client's pinned plugins in Environments before adding a model.",
  keepAtLeastOneClientAndModel: "Keep at least one client and model.",
  couldNotSaveTheSelectedClientsAndModelsTryAgain:
    "Could not save the selected clients and models. Try again.",
  couldNotLoadThisSummaryHitRetryInTheHeader:
    "Could not load this summary. Hit Retry in the header.",
  serverAuthorizationIsRequiredCheckTheConnectionAndRetry:
    "Server authorization is required. Check the connection and retry.",
  failedToLoadSavedModelRequests: "Failed to load saved model requests",
  invalidSavedModelRequests: "Invalid saved model requests",
  anotherSuiteRunIsAlreadyStarting: "Another suite run is already starting.",
  liveSuiteServersAreUnavailableConnectThemBeforeRunningFrom:
    "Live suite servers are unavailable. Connect them before running from eval chat.",
  theSuiteIsNotReadyToRunCheckItsCases:
    "The suite is not ready to run. Check its cases and client configuration.",
  generationIsAlreadyRunning: "Generation is already running.",
  attachServersToThisSuiteBeforeGeneratingCases:
    "Attach servers to this suite before generating cases.",
  connectTheSuiteServersBeforeGeneratingCases:
    "Connect the suite servers before generating cases.",
  someGeneratedDraftsCouldNotBeStagedReviewTheAvailable:
    "Some generated drafts could not be staged. Review the available drafts before trying again.",
  notAvailableForGuestsYetSignInToUseThis:
    "Not available for guests yet. Sign in to use this.",
  runIsUnavailable: "Run is unavailable",
  iterationHistoryIsIncomplete: "Iteration history is incomplete",
  anotherChangeToThisSuiteLandedFirstTryAddingIt:
    "Another change to this suite landed first. Try adding it again.",
  selectAtLeastOneCaseBeforeRunning: "Select at least one case before running.",
  selectAConfiguredClientBeforeRunning:
    "Select a configured client before running.",
  couldNotSaveThePreparedSuite: "Could not save the prepared suite.",
  reloadThisReviewBeforeEditing: "Reload this review before editing.",
  reloadThisReviewBeforeRefining: "Reload this review before refining.",
  aSelectedClientIsNoLongerAvailableRemoveItAnd:
    "A selected client is no longer available. Remove it and select another.",
  theSuiteSClientsAreStillLoadingTryAgainShortly:
    "The suite's clients are still loading. Try again shortly.",
  thisDeploymentDoesNotSupportOneRunClientModelChanges:
    "This deployment does not support one-run client/model changes yet. Save these pairings in suite settings or use the configured pairings.",
  couldNotResolveTheSelectedClientsAndModelsTryAgain:
    "Could not resolve the selected clients and models. Try again.",
  selectAtLeastOneClientAndModel: "Select at least one client and model.",
  theSelectedTargetsAreNoLongerAttachedToThisSuite:
    "The selected targets are no longer attached to this suite.",
  thisLinkIsInvalidOrExpiredAskWhoeverSharedIt:
    "This link is invalid or expired. Ask whoever shared it for a new one if you still need access.",
  weCouldnTOpenThisLinkRightNowPleaseTry:
    "We couldn't open this link right now. Please try again or open MCPJam.",
  subscribeFailed: "Subscribe failed",
  attachmentsNotLoaded: "Attachments not loaded",
  aWriteIsAlreadyInFlight: "A write is already in flight",
  theConversationIsStillLoading: "The conversation is still loading.",
  selectAProjectBeforeChangingTheServerUrl:
    "Select a project before changing the server URL.",
  couldNotResolveThisSetup: "Could not resolve this setup.",
  timedOutPreparingTheWorkspaceForThisServerReloadAnd:
    "Timed out preparing the workspace for this server. Reload and try again.",
  stillSettingUpYourWorkspaceGiveItAMomentAnd:
    "Still setting up your workspace. Give it a moment and try again.",
  enterAValidEmailAddress: "Enter a valid email address.",
  theServerSentAnUnreadableResponse: "The server sent an unreadable response.",
  buildserverfixpromptRequiresAFindingPromotedToMcpServerReadyWith:
    "buildServerFixPrompt requires a finding promoted to mcp_server/ready with a resolved target",
  paginationDidNotReturnANewContinuecursor:
    "Pagination did not return a new continueCursor",
  thisShareLinkIsInvalidOrHasBeenRevoked:
    "This share link is invalid or has been revoked.",
  generationReturnedNoGoalsTryAgainOrMakeSureThe:
    "Generation returned no goals. Try again, or make sure the environment's servers have been connected so their tools are inspected.",
  noGoalsCouldBeSavedForThisPersona:
    "No goals could be saved for this persona.",
  generationReturnedNoPersonasTryAgainOrMakeSureThe:
    "Generation returned no personas. Try again, or make sure the environment's servers have been connected so their tools are inspected.",
  couldNotResolveWhereThisShouldRun: "Could not resolve where this should run.",
  usecarouselMustBeUsedWithinACarousel:
    "useCarousel must be used within a <Carousel />",
  usechartMustBeUsedWithinAChartcontainer:
    "useChart must be used within a <ChartContainer />",
  usesidebarMustBeUsedWithinASidebarprovider:
    "useSidebar must be used within a SidebarProvider.",
  useplaygroundstatecontextMustBeUsedInsideAPlaygroundstateprovider:
    "usePlaygroundStateContext must be used inside a PlaygroundStateProvider",
  appIframeWasTornDownMidDispatch: "App iframe was torn down mid-dispatch",
  toolnameIsRequired: "toolName is required",
  thisSessionSDynamicRegistrationCredentialsAreNoLongerAvailable:
    "This session's dynamic registration credentials are no longer available. Register another client and rerun the flow.",
  thisSessionSDynamicClientSecretHasExpiredRegisterAnother:
    "This session's dynamic client secret has expired. Register another client and rerun the flow.",
  authorizationCompletedButMcpjamCouldNotFindTheAccessToken:
    "Authorization completed, but MCPJam could not find the access token. Try again.",
  authorizationCompletedButMcpjamCouldNotVerifyAccessTryAgain:
    "Authorization completed, but MCPJam could not verify access. Try again.",
  authorizationExpiredOrIsMissingAuthorizeAgainToContinue:
    "Authorization expired or is missing. Authorize again to continue.",
  couldnTMoveThisConversationToANewThreadReload:
    "Couldn't move this conversation to a new thread. Reload the page before sending again.",
  chatIsNotReadyToResumeThisOperation:
    "Chat is not ready to resume this operation.",
  hostedChatContextIsNotReadyMissingProjectid:
    "Hosted chat context is not ready: missing projectId.",
  theChatChangedWhileReturningBrowserControlSendYourMessage:
    "The chat changed while returning browser control. Send your message again.",
  projectsEnsuredefaultprojectReturnedANonStringId:
    "projects:ensureDefaultProject returned a non-string id",
  organizationIsRequired: "Organization is required",
  projectClientConfigSyncWasInterrupted:
    "Project client config sync was interrupted.",
  failedToDeleteProject: "Failed to delete project",
  someoneElseUpdatedThisChatWhileYouWereReplyingYour:
    "Someone else updated this chat while you were replying. Your reply stayed here; your next message will start a new thread.",
  thisReplyCouldnTBeSavedToYourChatHistory:
    "This reply couldn't be saved to your chat history. It's still visible here.",
  cannotSaveServerTheSelectedProjectIsNotInThe:
    "Cannot save server: the selected project is not in the active organization. Refresh and try again.",
  cannotReplaceAndClearTheOauthClientSecretInThe:
    "Cannot replace and clear the OAuth client secret in the same save.",
  noServerUrlFoundForOauthFlow: "No server URL found for OAuth flow",
  agentOpsReturnedNoOperationsArray: "agent-ops returned no operations array",
  signInAndSelectAnOrganizationFirst:
    "Sign in and select an organization first.",
  selectAnOrganizationFirst: "Select an organization first.",
  automaticRefillsAreUnavailableSaveSettingsAndReviewTheCurrent:
    "Automatic refills are unavailable. Save settings and review the current quote first.",
  emptyBrowserCatalog: "Empty Browser catalog",
  signInAndSelectAProjectToUseTheComputer:
    "Sign in and select a project to use the computer.",
  computersAreStillLoadingTryAgainInAMoment:
    "Computers are still loading, try again in a moment.",
  computersAreNotAvailableOnThisServer:
    "Computers are not available on this server.",
  checkoutUrlMissingFromResponse: "Checkout URL missing from response",
  refusingToRedirectToNonStripeCheckoutUrl:
    "Refusing to redirect to non-Stripe checkout URL",
  changedWhileThisMutationWasBeingRun:
    "changed while this mutation was being run",
  harnessCapabilitiesUnexpectedShape: "harness capabilities: unexpected shape",
  thisProjectIsNotPartOfAnOrganization:
    "This project is not part of an organization.",
  weCouldNotReadThisServerSDetailsTryThe:
    "We could not read this server's details. Try the address again.",
  missingRegistryEntryId: "Missing registry entry id",
  selectAProjectFirst: "Select a project first.",
  paymentConfirmationIsUnavailable: "Payment confirmation is unavailable",
  paymentWasNotCompleted: "Payment was not completed",
  stripeHasNoDefaultPaymentMethodForThisSubscriptionAdd:
    "Stripe has no default payment method for this subscription. Add or select a card in Billing, then click Finish payment again.",
  paymentFailedTheMemberWasNotAdded:
    "Payment failed. The member was not added.",
  thisSeatPaymentCanNoLongerBeRetriedTryAdding:
    "This seat payment can no longer be retried. Try adding the member again.",
  snapshotUploadDidNotReturnAStorageid:
    "Snapshot upload did not return a storageId",
  sessionNotFoundForChatSession: "Session not found for chat session",
  noInsightsScopeToRebuild: "No insights scope to rebuild",
  couldNotLoadThisBenchmarkResult: "Could not load this benchmark result.",
  anOpenaiReadinessRunNeedsADeclaredSubmissionMode:
    "An OpenAI readiness run needs a declared submission mode.",
  signInToAuthorCases: "Sign in to author cases.",
  noResponseBodyForStreaming: "No response body for streaming",
  signInToImportCases: "Sign in to import cases.",
  theImportServiceReturnedAnInvalidResponseYourMarkdownFile:
    "The import service returned an invalid response. Your Markdown file was not the problem. Please try again.",
  theSaveResponseWasIncompleteRetryTheSameSaveTo:
    "The save response was incomplete. Retry the same save to confirm which cases were imported.",
  theSaveResponseCouldNotBeMatchedToTheSelected:
    "The save response could not be matched to the selected cases. Retry the same save.",
  noSkillMdFoundInTheFolder: "No SKILL.md found in the folder",
  editingIsOnlySupportedForCloudSkills:
    "Editing is only supported for cloud skills.",
  subscriptionBridgeReturnedNoState: "Subscription bridge returned no state",
  serveridIsRequiredInHostedMode: "serverId is required in hosted mode",
  toolExecutionRequiresElicitationWhichIsNotSupportedInThe:
    "Tool execution requires elicitation, which is not supported in the emulator yet.",
  liveRenderIsOnlyAvailableInTheLocalInspector:
    "Live render is only available in the local inspector.",
  couldNotSaveThisRun: "Could not save this run.",
  couldNotLoadThisResult: "Could not load this result.",
  theServerReturnedAResponseThatWasNotJson:
    "The server returned a response that was not JSON.",
  hostedApiContextIsOnlyAvailableInHostedMode:
    "Hosted API context is only available in hosted mode",
  hostedServerNotFoundTheServerIsNotInYour:
    "Hosted server not found. The server is not in your hosted project, or the server list is still loading.",
  noAccessTokenAvailable: "No access token available",
  workosSessionRefreshFailed: "WorkOS session refresh failed",
  cardSetupIsNotConfiguredForThisEnvironment:
    "Card setup is not configured for this environment.",
  couldNotInitializeSecureCardSetup: "Could not initialize secure card setup.",
  cardSetupWasNotCompletedCheckItsStatusBeforeContinuing:
    "Card setup was not completed. Check its status before continuing.",
  theBrowserProfileRequestFailed: "The browser profile request failed.",
  theBrowserProfileUploadUrlWasNotReturned:
    "The browser profile upload URL was not returned.",
  theBrowserProfileArchiveCouldNotBeUploaded:
    "The browser profile archive could not be uploaded.",
  theBrowserProfileUploadDidNotReturnAStorageId:
    "The browser profile upload did not return a storage id.",
  theBrowserProfileWasNotCreated: "The browser profile was not created.",
  couldnTReturnBrowserControlToTheAgentTrySending:
    "Couldn't return browser control to the agent. Try sending your message again.",
  localExecutionIsNotAuthorizedForThisTurn:
    "Local execution is not authorized for this turn",
  projectConnectionDefaultsAreStillSyncingTryAgainInA:
    "Project connection defaults are still syncing. Try again in a moment.",
  finishingSetup: "Finishing setup.",
  hostStylesHostStyleIdIsRequired: "[host-styles] Host style id is required.",
  workosRedirectUriRequiresAnHttpSBrowserOrigin:
    "WorkOS redirect URI requires an HTTP(S) browser origin.",
  notAuthenticated: "Not authenticated",
  connectAGithubAccountAndReloadTheRepositoryList:
    "Connect a GitHub account and reload the repository list.",
  theHostedBrowserViewNeedsHttpsOrALoopbackAddress:
    "The hosted browser view needs https (or a loopback address).",
  theLocalBrowserIsNotAvailableHere: "The local browser is not available here.",
  couldnTVerifyBrowserPermissionRetrySetup:
    "Couldn't verify Browser permission. Retry setup.",
  browserPermissionWasSavedButClientsCouldNotBeEnabled:
    "Browser permission was saved, but clients could not be enabled. Retry setup.",
  ensuredefaultprojectReturnedNoProjectId:
    "ensureDefaultProject returned no project id",
  describeWhatYouWantToTestFirst: "Describe what you want to test first.",
  describeWhatYouWantToTest: "Describe what you want to test.",
  onlyOneFollowUpIsAllowedPrepareTheProposalUsing:
    "Only one follow-up is allowed. Prepare the proposal using the user's answer and tool metadata.",
  aQuestionIsUnavailableInThisPhase: "A question is unavailable in this phase.",
  waitForTheUserSDescriptionOrAnswerBeforeProposing:
    "Wait for the user's description or answer before proposing cases.",
  toolsAreStillUnavailableRetryTheConnectionBeforePreparingTests:
    "Tools are still unavailable. Retry the connection before preparing tests.",
  draftChangedReadContextAgain: "Draft changed. Read context again.",
  proposalTargetIsUnavailableReturnToDescribe:
    "Proposal target is unavailable. Return to Describe.",
  proposalChangedReviewTheCurrentProposal:
    "Proposal changed. Review the current proposal.",
  proposalTargetChangedReturnToDescribe:
    "Proposal target changed. Return to Describe.",
  reviewAProposalBeforeCreatingCases:
    "Review a proposal before creating cases.",
  toolsChangedDescribeTheTestAgainToPrepareAnUpdated:
    "Tools changed. Describe the test again to prepare an updated proposal.",
  toolsAreUnavailableRetryTheConnectionBeforeCreatingTests:
    "Tools are unavailable. Retry the connection before creating tests.",
  draftChangedDescribeTheChangeAgainToPrepareAnUpdated:
    "Draft changed. Describe the change again to prepare an updated proposal.",
  evalContextIsUnavailableReopenAskMcpjamFromTheCase:
    "Eval context is unavailable. Reopen Ask MCPJam from the case or suite.",
  evalContextChangedDuringThisTurnSubmitANewRequest:
    "Eval context changed during this turn. Submit a new request for the current case.",
  returnToDescribeToContinueCreatingTests:
    "Return to Describe to continue creating tests.",
  toolMetadataTimedOut: "Tool metadata timed out",
  returnToTheSelectedCaseEditorBeforeReadingOrChanging:
    "Return to the selected case editor before reading or changing its draft.",
  returnToTheSelectedEvalSuiteToContinueNoNavigation:
    "Return to the selected eval suite to continue. No navigation was performed.",
  caseTitleMustNotBeEmpty: "Case title must not be empty.",
  stepIdsMustBeUnique: "Step ids must be unique.",
  provideTitleOrStepsToEdit: "Provide title or steps to edit.",
  generationIsAlreadyRunningReadContextForProgressDoNot:
    "Generation is already running. Read context for progress; do not start another job.",
  generatedCaseIsOutsideTheScopedSuite:
    "Generated case is outside the scoped suite.",
  generatedDraftChangedOrIsUnavailableReadContextBeforeRetrying:
    "Generated draft changed or is unavailable. Read context before retrying.",
  draftIsOutsideTheSelectedSuite: "Draft is outside the selected suite.",
  addACaseTitleBeforeSaving: "Add a case title before saving.",
  completeTheCaseStepsBeforeSaving: "Complete the case steps before saving.",
  saveOutcomeIsUnknownRetryToConfirm:
    "Save outcome is unknown. Retry to confirm.",
  runningEvalsIsUnavailableInThisWorkspace:
    "Running evals is unavailable in this workspace.",
  aSuiteRunIsAlreadyStarting: "A suite run is already starting.",
  draftChangedSinceItWasReadReadContextAgainNo:
    "Draft changed since it was read. Read context again; no edits were applied.",
  cannotUndoAfterAnotherEditYourCurrentDraftWasPreserved:
    "Cannot undo after another edit. Your current draft was preserved.",
  caseDraftIsLoading: "Case draft is loading.",
  thisOrganizationSSpendBudgetIsReachedAnOwnerOr:
    "This organization's spend budget is reached. An owner or admin can raise it in Organization → Billing.",
  cimdMissingOrInvalidRedirectUrisArray:
    "CIMD missing or invalid redirect_uris array",
  cimdMissingRequiredFieldClientName:
    "CIMD missing required field: client_name",
  noCodeVerifierSavedForDebugSession:
    "No code verifier saved for debug session",
  rejectedOauthResourceIndicatorFromProtectedResourceMetadataTheDocument:
    'Rejected OAuth resource indicator from protected resource metadata: the document is missing its required "resource" identifier (RFC 9728 §2).',
  oauthStateNotReadyForHostedCallbackSession:
    "OAuth state not ready for hosted callback session.",
  oauthClientIdNotReadyForHostedCallbackSession:
    "OAuth client ID not ready for hosted callback session.",
  codeVerifierNotReadyForHostedCallbackSession:
    "Code verifier not ready for hosted callback session.",
  oauthTokenResponseMissingAccessTokenCannotImportTokensTo:
    "OAuth token response missing access_token; cannot import tokens to Convex",
  oauthServerIsNotSyncedCannotStoreTokensSecurely:
    "OAuth server is not synced; cannot store tokens securely",
  oauthClientInformationMissingClientIdCannotImportTokensTo:
    "OAuth client information missing client_id; cannot import tokens to Convex",
  codeVerifierNotFound: "Code verifier not found",
  unknownOauthError: "Unknown OAuth error",
  noPendingOauthFlowFound: "No pending OAuth flow found",
  oauthCallbackIsMissingServerContext:
    "OAuth callback is missing server context",
  serverUrlNotFoundForOauthCallback: "Server URL not found for OAuth callback",
  oauthStateMismatchTheCallbackDidNotReturnTheValue:
    "OAuth `state` mismatch, the callback did not return the value this flow issued (possible CSRF). Authorization was not completed.",
  oauthClientIdNotFound: "OAuth client ID not found",
  stripeIsOnlyAvailableInTheBrowser: "Stripe is only available in the browser",
  failedToLoadStripe: "Failed to load Stripe",
  failedToInitializeStripe: "Failed to initialize Stripe",
  noResponseBodyForSwarmRunStream: "No response body for swarm run stream",
  guestSessionBootstrapExhaustedWithoutAToken:
    "Guest session bootstrap exhausted without a token",
  evalAuthoringRequiresAScopedAgentSession:
    "Eval authoring requires a scoped agent session.",
  openAskMcpjamFromTheEvalWorkspaceFirst:
    "Open Ask MCPJam from the eval workspace first.",
  browserInputWasInterruptedItMayAlreadyHaveExecutedIt:
    "Browser input was interrupted; it may already have executed. It was not replayed.",
  browserInputIsBusyWaitForTheCurrentGestureTo:
    "Browser input is busy. Wait for the current gesture to finish.",
  completeOrClearTheServerIdentityOverride:
    "Complete or clear the server identity override",
  usesharedappstateMustBeUsedWithinAppstateprovider:
    "useSharedAppState must be used within AppStateProvider",
  projectidIsRequiredForTestconnectionInLocalModeServerMust:
    "projectId is required for testConnection in local mode (server must be synced to Convex first)",
  projectidIsRequiredForReconnectserverInLocalModeServerMust:
    "projectId is required for reconnectServer in local mode (server must be synced to Convex first)",
  useserveractionsMustBeUsedWithinServeractionsprovider:
    "useServerActions must be used within ServerActionsProvider",
  connectiondefaultsRequesttimeoutMustBeAPositiveNumber:
    "connectionDefaults.requestTimeout must be a positive number",
  connectiondefaultsHeadersMustBeAJsonObject:
    "connectionDefaults.headers must be a JSON object",
  connectiondefaultsHeadersMustNotIncludeAuthorization:
    "connectionDefaults.headers must not include Authorization",
  missingPreferencesstoreprovider: "Missing PreferencesStoreProvider",

  // Operation failures without backend diagnostic text.
  executionFailedPleaseTryAgain: "Execution failed. Please try again.",
  failedToImportServersPleaseTryAgain:
    "Failed to import servers. Please try again.",
  failedToCopyAgentBriefPleaseTryAgain:
    "Failed to copy agent brief. Please try again.",
  tunnelCreationFailedPleaseTryAgain:
    "Tunnel creation failed. Please try again.",
  failedToCloseTunnelPleaseTryAgain:
    "Failed to close tunnel. Please try again.",
  failedToRotateTunnelPleaseTryAgain:
    "Failed to rotate tunnel. Please try again.",
  useForceDeleteOrRemoveDependentUserTestingScenariosEvals:
    "This client is still in use. Remove its dependent studies and evals before deleting it.",
  oauthSucceededButConnectionTestFailedPleaseTryAgain:
    "Sign-in finished, but the server connection could not be verified. Check the server’s status, then reconnect.",
  errorCompletingOauthFlowPleaseTryAgain:
    "We couldn’t finish connecting your account. Start sign-in again.",
  oauthAuthorizationFailedPleaseTryAgain:
    "We couldn’t authorize this connection. Sign in to the server again.",
  oauthSucceededButConnectionFailedPleaseTryAgain:
    "Sign-in finished, but the server didn’t connect. Check the server’s status, then reconnect.",
  oauthInitializationFailedPleaseTryAgain:
    "We couldn’t start sign-in for this server. Check its authentication settings, then try again.",
  connectionFailedPleaseTryAgain: "Connection failed. Please try again.",
  tokenRefreshFailedPleaseTryAgain:
    "Your server connection could not be renewed. Sign in to the server again.",
} as const;

export type ErrorMessageKey = keyof typeof ERROR_MESSAGES;
export type UserErrorMessage = (typeof ERROR_MESSAGES)[ErrorMessageKey];

/** Contextual copy. Arguments are display names or counts, never backend errors. */
export const ERROR_MESSAGE_TEMPLATES = {
  isNotAvailableYet: (clientName: string | number) =>
    `${clientName} is not available yet.`,
  isNotAvailableInHostedMode: (featureName: string | number) =>
    `${featureName} is not available in hosted mode.`,
  isNotIncludedInThePlanUpgradeTheOrganizationTo: (
    featureName: string | number,
    planName: string | number,
  ) =>
    `${featureName} is not included in the ${planName} plan. Upgrade the organization to continue.`,
  couldnTFindToMove: (serverName: string | number) =>
    `Couldn't find "${serverName}" to move.`,
  isnTSyncedYet: (projectName: string | number) =>
    `"${projectName}" isn't synced yet.`,
  hasnTFinishedSyncingYetTryAgainInAMoment: (serverName: string | number) =>
    `"${serverName}" hasn't finished syncing yet. Try again in a moment.`,
  couldnTPublishPleaseTryAgain: (skillName: string | number) =>
    `Couldn't publish "${skillName}". Please try again.`,
  failedToExportPleaseTryAgain: (serverName: string | number) =>
    `Failed to export ${serverName}. Please try again.`,
  aServerNamedAlreadyExistsChooseADifferentName: (
    serverName: string | number,
  ) =>
    `A server named "${serverName}" already exists. Choose a different name.`,
  aCaseCanHaveAtMostAttachments: (maximumCount: string | number) =>
    `A case can have at most ${maximumCount} attachments.`,
  attachmentsExceedTheMbPerCaseLimit: (maximumMegabytes: string | number) =>
    `Attachments exceed the ${maximumMegabytes} MB per-case limit.`,
  anAttachmentNamedAlreadyExists: (fileName: string | number) =>
    `An attachment named "${fileName}" already exists.`,
  modelCompletedSuccessfully: (
    successfulCount: string | number,
    requestedCount: string | number,
    pluralSuffix: string | number,
  ) =>
    `${successfulCount}/${requestedCount} model${pluralSuffix} completed successfully.`,
  failedToCopy2: (itemName: string | number) => `Failed to copy ${itemName}`,
  suiteDefaultModelIsNotAvailableReSelectItIn: (modelName: string | number) =>
    `Suite default model ${modelName} is not available. Re-select it in the suite's default execution config, or add per-case models.`,
  failedToCreatePleaseTryAgain: (clientName: string | number) =>
    `Failed to create ${clientName}. Please try again.`,
  needsAuthorizingBeforeItCanConnect: (serverName: string | number) =>
    `${serverName} needs authorizing before it can connect.`,
  didnTConnect: (serverName: string | number) =>
    `${serverName} didn't connect.`,
  signedInButCouldNotBeSavedThatNameAlready: (serverName: string | number) =>
    `Signed in, but "${serverName}" could not be saved: that name already belongs to another project in this workspace.`,
  failedToConnectToPleaseTryAgain: (serverName: string | number) =>
    `Failed to connect to ${serverName}. Please try again.`,
  aServerNamedAlreadyExistsInThisWorkspaceChooseA: (
    serverName: string | number,
  ) =>
    `A server named "${serverName}" already exists in this workspace. Choose a different name.`,
} as const;
