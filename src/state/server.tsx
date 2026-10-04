import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchHealth, fetchModels } from "../lib/api";
import { AUTO_MODEL_ID, type DemoLimits, type HealthStatus, type ModelInfo } from "../types";
import { useSettings } from "./settings";

interface ServerContextValue {
  models: ModelInfo[];
  modelsStatus: "loading" | "ready" | "error";
  modelsError: string | null;
  reloadModels: () => void;
  /** The model new messages are sent to: the Auto router (default) or the user's manual choice. */
  activeModel: ModelInfo | null;
  isAuto: boolean;
  /** The Auto router as a model entry (null until models load). */
  autoModel: ModelInfo | null;
  modelLabel: (id?: string) => string;
  /** Deployment limits from the server (null until models load). */
  limits: DemoLimits | null;
  health: HealthStatus;
  healthMessage: string;
  recheckHealth: () => void;
}

const ServerContext = createContext<ServerContextValue | null>(null);

export function ServerProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [limits, setLimits] = useState<DemoLimits | null>(null);
  const [modelsStatus, setModelsStatus] = useState<ServerContextValue["modelsStatus"]>("loading");
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthStatus>("checking");
  const [healthMessage, setHealthMessage] = useState("Checking connection…");

  const reloadModels = useCallback(() => {
    setModelsStatus("loading");
    setModelsError(null);
    fetchModels()
      .then((r) => {
        setModels(r.models);
        setDefaultModel(r.defaultModel);
        setLimits(r.limits ?? null);
        setModelsStatus("ready");
      })
      .catch((err: Error) => {
        setModelsError(err.message);
        setModelsStatus("error");
      });
  }, []);

  const checkHealth = useCallback((fresh: boolean) => {
    setHealth("checking");
    setHealthMessage("Checking connection…");
    fetchHealth(fresh).then((r) => {
      setHealth(r.status);
      setHealthMessage(r.message);
    });
  }, []);

  // User-initiated and error-triggered checks always ask the providers again.
  const recheckHealth = useCallback(() => checkHealth(true), [checkHealth]);

  useEffect(() => {
    reloadModels();
    checkHealth(false);
  }, [reloadModels, checkHealth]);

  // Auto behaves like a model whose capabilities are the best of the available ones.
  const auto = useMemo<ModelInfo | null>(
    () =>
      models.length
        ? {
            id: AUTO_MODEL_ID,
            label: "Auto",
            vendor: "HiveMind",
            provider: "the best available model",
            description: "Picks the best available model for each message.",
            reasoning: models.some((m) => m.reasoning === "toggle") ? "toggle" : "always",
            maxOutput: Math.max(...models.map((m) => m.maxOutput)),
            contextWindow: Math.max(...models.map((m) => m.contextWindow ?? 0)) || null,
          }
        : null,
    [models],
  );
  // A saved manual model that no longer exists falls back to Auto.
  const manual = settings.model && settings.model !== AUTO_MODEL_ID ? models.find((m) => m.id === settings.model) : undefined;
  const fallbackDefault = defaultModel && defaultModel !== AUTO_MODEL_ID ? models.find((m) => m.id === defaultModel) : undefined;
  const activeModel = manual ?? (settings.model === AUTO_MODEL_ID || !fallbackDefault ? auto : fallbackDefault) ?? null;
  const isAuto = activeModel?.id === AUTO_MODEL_ID;

  const modelLabel = useCallback(
    (id?: string) => (id === AUTO_MODEL_ID ? "Auto" : (models.find((m) => m.id === id)?.label ?? id?.split("/").pop()?.replace(/:free$/, "") ?? "Assistant")),
    [models],
  );

  const value = useMemo(
    () => ({ models, modelsStatus, modelsError, reloadModels, activeModel, isAuto, autoModel: auto, modelLabel, limits, health, healthMessage, recheckHealth }),
    [models, modelsStatus, modelsError, reloadModels, activeModel, isAuto, auto, modelLabel, limits, health, healthMessage, recheckHealth],
  );
  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

export function useServer() {
  const ctx = useContext(ServerContext);
  if (!ctx) throw new Error("useServer must be used inside ServerProvider");
  return ctx;
}
