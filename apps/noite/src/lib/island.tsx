//! Props for `@ilha/model` islands.
//!
//! `defineApp` components take no props: `init` and `view` see only the
//! model. A control-UI island almost always needs inputs (an app id, the row
//! it draws), so `islandProps` carries them through an ilha context. `wrap`
//! turns the app into an ordinary props-taking component that provides them,
//! and `read` returns them during render — in `init`, to seed the model, and
//! in `view`, for inputs the parent keeps changing (feed rows, roles).
//!
//! The model holds only the island's own state machine; inputs stay inputs.
//! `init` runs once per mounted instance, so a value it copies into the model
//! is fixed for that instance's life: route bodies are keyed by their params,
//! so a new app id remounts the island. A command that needs an input gets it
//! from the message that started it, never from `read` (commands run outside
//! render).
import type { ModelApp } from "@ilha/model";
import { context, createContext } from "ilha";
import type { View } from "ilha";

/** One island's inputs: read them during render, or wrap the app with them. */
export interface IslandProps<P> {
  /** The island's current inputs. Call only while rendering (`init`,
   * `view`): it reads the nearest provider. */
  readonly read: () => P;
  /** The props-taking component that mounts `app` under these inputs. */
  readonly wrap: <Model, Message, R, E>(
    app: ModelApp<Model, Message, R, E>
  ) => (props: P) => View;
}

/** Declare an island's inputs. `name` labels the error a render outside the
 * provider throws (an island mounted without `wrap`). */
export const islandProps = <P extends object>(name: string): IslandProps<P> => {
  const ctx = createContext<P | undefined>(undefined);

  return {
    read: (): P => {
      const props = context(ctx)();

      if (props === undefined) {
        throw new Error(`${name} rendered outside its props provider`);
      }

      return props;
    },
    wrap: (app) => {
      const Island = app.component;

      return (props) => (
        <ctx.Provider value={props}>
          <Island />
        </ctx.Provider>
      );
    },
  };
};
