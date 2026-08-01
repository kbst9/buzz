import * as React from "react";
import {
  WELCOME_COMPOSER_BANNER_DISMISS_DURATION_SECONDS,
  WELCOME_COMPOSER_BANNER_HIDE_BUFFER_MS,
  WELCOME_COMPOSER_BANNER_SUCCESS_SETTLE_MS,
  WELCOME_PERSONA_ROTATION_MS,
  type WelcomeComposerBannerState,
} from "@/features/channels/ui/WelcomeComposerBanner";

/**
 * State machine for the welcome-channel composer banner.
 *
 * The banner shows a prompt until the member sends a message that engages a
 * welcome persona, then settles through `complete` → `dismissing` → `hidden`
 * on timers. Channels that already completed the banner stay hidden for the
 * rest of the session; switching channels resets the prompt otherwise.
 */
export function useWelcomeComposerBanner({
  activeChannelId,
  isActiveWelcomeChannel,
}: {
  activeChannelId: string | null;
  isActiveWelcomeChannel: boolean;
}): {
  welcomeComposerBannerState: WelcomeComposerBannerState;
  completeWelcomeComposerBanner: () => void;
} {
  const completedWelcomeBannerChannelIdsRef = React.useRef(new Set<string>());
  const welcomeComposerDismissTimerRef = React.useRef<number | null>(null);
  const welcomeComposerHideTimerRef = React.useRef<number | null>(null);
  const [welcomeComposerBannerState, setWelcomeComposerBannerState] =
    React.useState<WelcomeComposerBannerState>("prompt");

  const clearWelcomeComposerDismissTimer = React.useCallback(() => {
    if (welcomeComposerDismissTimerRef.current !== null) {
      window.clearTimeout(welcomeComposerDismissTimerRef.current);
      welcomeComposerDismissTimerRef.current = null;
    }
    if (welcomeComposerHideTimerRef.current !== null) {
      window.clearTimeout(welcomeComposerHideTimerRef.current);
      welcomeComposerHideTimerRef.current = null;
    }
  }, []);

  React.useEffect(
    () => () => clearWelcomeComposerDismissTimer(),
    [clearWelcomeComposerDismissTimer],
  );

  React.useEffect(() => {
    clearWelcomeComposerDismissTimer();

    if (
      activeChannelId &&
      isActiveWelcomeChannel &&
      completedWelcomeBannerChannelIdsRef.current.has(activeChannelId)
    ) {
      setWelcomeComposerBannerState("hidden");
      return;
    }

    setWelcomeComposerBannerState("prompt");
  }, [
    activeChannelId,
    clearWelcomeComposerDismissTimer,
    isActiveWelcomeChannel,
  ]);

  const completeWelcomeComposerBanner = React.useCallback(() => {
    if (!activeChannelId || !isActiveWelcomeChannel) {
      return;
    }

    clearWelcomeComposerDismissTimer();
    completedWelcomeBannerChannelIdsRef.current.add(activeChannelId);
    setWelcomeComposerBannerState("complete");
    welcomeComposerDismissTimerRef.current = window.setTimeout(() => {
      setWelcomeComposerBannerState("dismissing");
      welcomeComposerDismissTimerRef.current = null;
      welcomeComposerHideTimerRef.current = window.setTimeout(
        () => {
          setWelcomeComposerBannerState("hidden");
          welcomeComposerHideTimerRef.current = null;
        },
        WELCOME_COMPOSER_BANNER_DISMISS_DURATION_SECONDS * 1000 +
          WELCOME_COMPOSER_BANNER_HIDE_BUFFER_MS,
      );
    }, WELCOME_PERSONA_ROTATION_MS + WELCOME_COMPOSER_BANNER_SUCCESS_SETTLE_MS);
  }, [
    activeChannelId,
    clearWelcomeComposerDismissTimer,
    isActiveWelcomeChannel,
  ]);

  return { welcomeComposerBannerState, completeWelcomeComposerBanner };
}
