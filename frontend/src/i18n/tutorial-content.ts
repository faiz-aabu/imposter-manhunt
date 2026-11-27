import type { TranslationKey } from "./locales";

export interface TutorialPointKeys {
  title: TranslationKey;
  description: TranslationKey;
}

export interface TutorialPageKeys {
  label: TranslationKey;
  title: TranslationKey;
  description: TranslationKey;
  points: readonly TutorialPointKeys[];
}

export const tutorialWelcomeKeys = {
  title: "tutorial.welcome.title",
  tagline: "tutorial.welcome.tagline",
  description: "tutorial.welcome.description",
} as const;

export const tutorialPages: readonly TutorialPageKeys[] = [
  {
    label: "tutorial.impostor.label",
    title: "tutorial.impostor.title",
    description: "tutorial.impostor.description",
    points: [
      {
        title: "tutorial.impostor.roles.title",
        description: "tutorial.impostor.roles.description",
      },
      {
        title: "tutorial.impostor.discuss.title",
        description: "tutorial.impostor.discuss.description",
      },
      {
        title: "tutorial.impostor.vote.title",
        description: "tutorial.impostor.vote.description",
      },
      {
        title: "tutorial.impostor.win.title",
        description: "tutorial.impostor.win.description",
      },
    ],
  },
  {
    label: "tutorial.manhunt.label",
    title: "tutorial.manhunt.title",
    description: "tutorial.manhunt.description",
    points: [
      {
        title: "tutorial.manhunt.teams.title",
        description: "tutorial.manhunt.teams.description",
      },
      {
        title: "tutorial.manhunt.boundary.title",
        description: "tutorial.manhunt.boundary.description",
      },
      {
        title: "tutorial.manhunt.missions.title",
        description: "tutorial.manhunt.missions.description",
      },
      {
        title: "tutorial.manhunt.outcomes.title",
        description: "tutorial.manhunt.outcomes.description",
      },
    ],
  },
  {
    label: "tutorial.abilities.label",
    title: "tutorial.abilities.title",
    description: "tutorial.abilities.description",
    points: [
      {
        title: "tutorial.abilities.runner.title",
        description: "tutorial.abilities.runner.description",
      },
      {
        title: "tutorial.abilities.hunter.title",
        description: "tutorial.abilities.hunter.description",
      },
      {
        title: "tutorial.abilities.inventory.title",
        description: "tutorial.abilities.inventory.description",
      },
      {
        title: "tutorial.abilities.noExtras.title",
        description: "tutorial.abilities.noExtras.description",
      },
    ],
  },
];
