import { ActionIcon, Box, Button, Group, Progress } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconX } from "@tabler/icons-react";
import { error } from "@tauri-apps/plugin-log";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useProgress } from "@/hooks/useProgress";
import classes from "./ProgressButton.module.css";

type Props = {
  id: string;
  initInstalled: boolean;
  onClick: (id: string) => void | Promise<void>;
  waitForAction?: boolean;
  onCancel?: () => void;
  leftIcon?: React.ReactNode;
  labels: {
    completed: string;
    action: string;
    inProgress: string;
    finalizing?: string;
  };
  disabled?: boolean;
  redoable?: boolean;
  inProgress: boolean;
  setInProgress: (inProgress: boolean) => void;
};

function reportError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  void error(message).catch(console.error);
  notifications.show({ title: "Error", message, color: "red", icon: <IconX /> });
}

function ProgressButton({
  id,
  initInstalled,
  onClick,
  onCancel,
  leftIcon,
  labels,
  disabled,
  redoable,
  inProgress,
  setInProgress,
  waitForAction = false,
}: Props) {
  const { progress, finished, isActive, clear } = useProgress(id);
  const [actionCompleted, setActionCompleted] = useState(false);
  const pending = useRef(false);
  const completed = initInstalled || (waitForAction ? actionCompleted : finished);

  const showProgress = waitForAction ? inProgress : isActive || inProgress;

  useEffect(() => {
    if (!waitForAction && finished) {
      setInProgress(false);
    }
  }, [finished, setInProgress, waitForAction]);

  const handleAction = useCallback(async () => {
    if (pending.current) return;
    pending.current = true;
    setInProgress(true);
    setActionCompleted(false);
    let failure: { cause: unknown } | undefined;
    try {
      await clear();
      await onClick(id);
      setActionCompleted(true);
    } catch (cause) {
      failure = { cause };
    } finally {
      try {
        await clear();
      } catch (cause) {
        failure ??= { cause };
      } finally {
        pending.current = false;
        setInProgress(false);
      }
    }
    if (failure) reportError(failure.cause);
  }, [clear, id, onClick, setInProgress]);

  const handleCancel = useCallback(async () => {
    try {
      onCancel?.();
      await clear();
    } catch (cause) {
      reportError(cause);
    } finally {
      setInProgress(false);
    }
  }, [onCancel, clear, setInProgress]);

  let label: string;
  if (completed) {
    label = labels.completed;
  } else {
    if (!showProgress && (waitForAction || progress === 0)) label = labels.action;
    else if (progress === 100) label = labels.finalizing ?? labels.inProgress;
    else label = labels.inProgress;
  }

  return (
    <Group gap="xs" wrap="nowrap">
      <Button
        fullWidth
        onClick={() => {
          if (waitForAction) void handleAction();
          else onClick(id);
        }}
        disabled={showProgress || (completed && !redoable) || disabled}
        leftSection={<Box className={classes.label}>{leftIcon}</Box>}
        autoContrast
      >
        <span className={classes.label}>{label}</span>
        {!completed && progress !== 0 && (!waitForAction || showProgress) && (
          <Progress
            pos="absolute"
            h="100%"
            value={progress}
            className={classes.progress}
            radius="sm"
          />
        )}
      </Button>
      {showProgress && onCancel && (
        <ActionIcon variant="default" size="lg" onClick={handleCancel} title="Cancel">
          <IconX size="1rem" />
        </ActionIcon>
      )}
    </Group>
  );
}

export default memo(ProgressButton);
