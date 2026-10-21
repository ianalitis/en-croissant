import {
  Alert,
  Box,
  Button,
  Center,
  Group,
  Image,
  Loader,
  Modal,
  Paper,
  ScrollArea,
  SimpleGrid,
  Tabs,
  Text,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { IconAlertCircle, IconDatabase, IconTrophy } from "@tabler/icons-react";
import { join, resolve } from "@tauri-apps/api/path";
import { error } from "@tauri-apps/plugin-log";
import { useAtom } from "jotai";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "@/bindings";
import { enginesAtom } from "@/state/atoms";
import { getEnginesDir } from "@/utils/directories";
import {
  type LocalEngine,
  type RemoteEngine,
  requiredEngineSettings,
  useDefaultEngines,
} from "@/utils/engines";
import { usePlatform } from "@/utils/files";
import { formatBytes } from "@/utils/format";
import ProgressButton from "../common/ProgressButton";
import EngineForm from "./EngineForm";

function AddEngine({
  opened,
  setOpened,
}: {
  opened: boolean;
  setOpened: (opened: boolean) => void;
}) {
  const { t } = useTranslation();

  const [allEngines, setEngines] = useAtom(enginesAtom);
  const engines = (allEngines ?? []).filter((e): e is LocalEngine => e.type === "local");

  const { os } = usePlatform();

  const { defaultEngines, error, isLoading } = useDefaultEngines(os, opened);

  const form = useForm<LocalEngine>({
    initialValues: {
      type: "local",
      id: crypto.randomUUID(),
      version: "",
      name: "",
      path: "",
      image: "",
      elo: undefined,
    },

    validate: {
      name: (value) => {
        if (!value) return t("Common.RequireName");
        if (engines.find((e) => e.name === value)) return t("Common.NameAlreadyUsed");
      },
      path: (value) => {
        if (!value) return t("Common.RequirePath");
      },
    },
  });

  return (
    <Modal
      opened={opened}
      onClose={() => setOpened(false)}
      title={t("Engines.Add.Title")}
      size="80%"
    >
      <Tabs defaultValue="download">
        <Tabs.List>
          <Tabs.Tab value="download">{t("Common.Download")}</Tabs.Tab>
          <Tabs.Tab value="cloud">{t("Engines.Add.Cloud")}</Tabs.Tab>
          <Tabs.Tab value="local">{t("Common.Local")}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="download" pt="xs">
          {isLoading && (
            <Center>
              <Loader />
            </Center>
          )}
          <ScrollArea.Autosize mah={720} offsetScrollbars>
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
              {defaultEngines?.map((engine, i) => (
                <EngineCard
                  engine={engine}
                  engineId={i}
                  key={i}
                  initInstalled={engines.some((e) => e.name === engine.name)}
                />
              ))}
              {error && (
                <Alert icon={<IconAlertCircle size="1rem" />} title={t("Common.Error")} color="red">
                  {t("Engines.Add.ErrorFetch")}
                </Alert>
              )}
            </SimpleGrid>
          </ScrollArea.Autosize>
        </Tabs.Panel>
        <Tabs.Panel value="cloud" pt="xs">
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
            <CloudCard
              engine={{
                id: crypto.randomUUID(),
                name: "ChessDB",
                type: "chessdb",
                url: "https://chessdb.cn",
              }}
            />
            <CloudCard
              engine={{
                id: crypto.randomUUID(),
                name: "Lichess Cloud",
                type: "lichess",
                url: "https://lichess.org",
              }}
            />
          </SimpleGrid>
        </Tabs.Panel>
        <Tabs.Panel value="local" pt="xs">
          <EngineForm
            submitLabel={t("Common.Add")}
            form={form}
            onSubmit={(values: LocalEngine) => {
              const engine = { ...values, id: crypto.randomUUID() };
              setEngines(async (prev) => [...(await prev), engine]);
              setOpened(false);
            }}
          />
        </Tabs.Panel>
      </Tabs>
    </Modal>
  );
}

function CloudCard({ engine }: { engine: RemoteEngine }) {
  const { t } = useTranslation();

  const [engines, setEngines] = useAtom(enginesAtom);
  return (
    <Paper withBorder radius="md" p={0} key={engine.name}>
      <Group wrap="nowrap" gap={0} grow>
        <Box p="sm" flex={1}>
          <Text tt="uppercase" c="dimmed" fw={700} size="xs">
            ENGINE
          </Text>
          <Text fw="bold" size="sm">
            {engine.name}
          </Text>
          <Text size="xs" c="dimmed" mb="xs">
            {engine.url}
          </Text>
          <Button
            disabled={(engines ?? []).find((e) => e.type === engine.type) !== undefined}
            fullWidth
            size="xs"
            onClick={() => {
              setEngines(async (prev) => [
                ...(await prev),
                {
                  ...engine,
                  id: crypto.randomUUID(),
                  type: engine.type,
                  loaded: true,
                  settings: [
                    {
                      name: "MultiPV",
                      value: "1",
                    },
                  ],
                },
              ]);
            }}
          >
            {t("Common.Add")}
          </Button>
        </Box>
      </Group>
    </Paper>
  );
}

function EngineCard({
  engine,
  engineId,
  initInstalled,
}: {
  engine: LocalEngine;
  engineId: number;
  initInstalled: boolean;
}) {
  const { t } = useTranslation();

  const [inProgress, setInProgress] = useState<boolean>(false);
  const [, setEngines] = useAtom(enginesAtom);
  const downloadEngine = useCallback(
    async (id: number, url: string) => {
      const enginesDir = await getEnginesDir();
      let path = await resolve(enginesDir, `${url.slice(url.lastIndexOf("/") + 1)}`);
      if (/\.(?:zip|tar|tar\.gz)(?:[?#]|$)/.test(url)) {
        path = enginesDir;
      }
      const download = await commands.downloadFile(`engine_${id}`, url, path, null, null, null);
      if (download.status === "error") throw new Error(download.error);
      let enginesDirPath = enginesDir;
      if (enginesDirPath.endsWith("/") || enginesDirPath.endsWith("\\")) {
        enginesDirPath = enginesDirPath.slice(0, -1);
      }
      const enginePath = await join(enginesDirPath, ...engine.path.split("/"));
      const executable = await commands.setFileAsExecutable(enginePath);
      if (executable.status === "error") throw new Error(executable.error);
      const config = await commands.getEngineConfig(enginePath);
      if (config.status === "error") throw new Error(config.error);
      const attemptedId = crypto.randomUUID();
      try {
        await setEngines(async (prev) => [
          ...(await prev),
          {
            ...engine,
            id: attemptedId,
            type: "local",
            path: enginePath,
            loaded: true,
            settings: config.data.options
              .filter((o) => requiredEngineSettings.includes(o.value.name))
              .map((o) => ({
                name: o.value.name,
                // @ts-expect-error
                value: o.value.default,
              })),
          },
        ]);
      } catch (cause) {
        try {
          // Jotai updates memory before persistence. Repair only this attempt, best effort.
          // Keep resolved-array updates synchronous so simultaneous rollbacks see each other.
          await setEngines((prev) =>
            Array.isArray(prev)
              ? prev.filter((e) => e.id !== attemptedId)
              : prev.then((engines) => engines.filter((e) => e.id !== attemptedId)),
          );
        } catch (compensationError) {
          void error(`Failed to persist engine registration rollback: ${compensationError}`).catch(
            console.error,
          );
        }
        throw cause;
      }
    },
    [engine, setEngines],
  );

  return (
    <Paper withBorder radius="md" p={0} key={engine.name}>
      <Group wrap="nowrap" gap={0} grow>
        {engine.image && (
          <Box w="1.75rem" px="xs">
            <Image src={engine.image} alt={engine.name} fit="contain" />
          </Box>
        )}
        <Box p="sm" flex={1}>
          <Text tt="uppercase" c="dimmed" fw={700} size="xs">
            ENGINE
          </Text>
          <Text fw="bold" size="sm" mb="xs">
            {engine.name} {engine.version}
          </Text>
          <Group wrap="nowrap" gap="xs" fz="xs">
            <IconTrophy size="1rem" />
            <Text size="xs">{`${engine.elo} ELO`}</Text>
          </Group>
          <Group wrap="nowrap" gap="xs" mb="xs" fz="xs">
            <IconDatabase size="1rem" />
            <Text size="xs">{formatBytes(engine.downloadSize ?? 0)}</Text>
          </Group>
          <ProgressButton
            id={`engine_${engineId}`}
            initInstalled={initInstalled && !inProgress}
            waitForAction
            disabled={!engine.downloadLink}
            labels={{
              completed: t("Common.Installed"),
              action: t("Common.Install"),
              inProgress: t("Common.Downloading"),
              finalizing: t("Common.Extracting"),
            }}
            onClick={() => {
              if (!engine.downloadLink) return;
              return downloadEngine(engineId, engine.downloadLink);
            }}
            inProgress={inProgress}
            setInProgress={setInProgress}
          />
        </Box>
      </Group>
    </Paper>
  );
}

export default AddEngine;
