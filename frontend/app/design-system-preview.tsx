import { useState } from "react";
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  Bell,
  Compass,
  Eye,
  MapPin,
  Settings,
} from "lucide-react-native";
import {
  Avatar,
  Chip,
  CodeInput,
  GameCard,
  HudPanel,
  IconButton,
  MapActionButton,
  MapBanner,
  PlayerRow,
  PrimaryButton,
  Screen,
  TextField,
  TopHudBar,
  VoteOption,
} from "../src/components";
import { colors, spacing, typography } from "../src/theme";

const colorOptions = [
  { label: "Host", variant: "gold" },
  { label: "Civilian", variant: "teal" },
  { label: "Impostor", variant: "pink" },
  { label: "Blue", variant: "blue" },
  { label: "Ready", variant: "white" },
  { label: "Out", variant: "muted" },
] as const;

export default function DesignSystemPreviewRoute() {
  const [code, setCode] = useState("");
  const [nickname, setNickname] = useState("Alex Morgan");
  const [selectedPlayer, setSelectedPlayer] = useState("Jordan Lee");

  return (
    <Screen scrollable>
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={styles.eyebrow}>IMPOSTOR & MANHUNT</Text>
          <Text style={styles.pageTitle}>Design system</Text>
          <Text style={styles.description}>
            Reusable mobile components and theme samples.
          </Text>
        </View>

        <Section title="HUD">
          <TopHudBar
            leftLabel="ROOM CODE"
            leftValue="Q7KM"
            rightLabel="TIME LEFT"
            rightValue="02:45"
          />
          <HudPanel highlightColor={colors.teal}>
            <Text style={styles.panelTitle}>Dark panel</Text>
            <Text style={styles.panelCopy}>
              Shared panel surface with a subtle outline and soft shadow.
            </Text>
          </HudPanel>
        </Section>

        <Section title="Buttons">
          <PrimaryButton title="Teal action" variant="teal" onPress={noop} />
          <PrimaryButton title="Pink action" variant="pink" onPress={noop} />
          <PrimaryButton title="Gold action" variant="gold" onPress={noop} />
          <PrimaryButton title="Green action" variant="green" onPress={noop} />
          <PrimaryButton
            title="Secondary action"
            variant="secondary"
            onPress={noop}
          />
          <PrimaryButton
            title="Disabled action"
            variant="teal"
            onPress={noop}
            disabled
          />
        </Section>

        <Section title="Chips and players">
          <View style={styles.chipRow}>
            {colorOptions.map((option) => (
              <Chip
                key={option.label}
                label={option.label}
                variant={option.variant}
              />
            ))}
          </View>
          <HudPanel style={styles.playerPanel}>
            <PlayerRow
              name="Alex Morgan"
              avatarColor={colors.violet}
              chip={{ label: "Host", variant: "gold" }}
            />
            <View style={styles.divider} />
            <PlayerRow
              name="Jordan Lee"
              avatarColor={colors.teal}
              status="Connected"
            />
            <View style={styles.avatarRow}>
              <Avatar name="Sam Rivera" fillColor={colors.pink} />
              <Avatar name="Taylor Kim" fillColor={colors.blue} />
              <Avatar name="Morgan Blake" fillColor={colors.green} />
            </View>
          </HudPanel>
        </Section>

        <Section title="Vote options">
          <VoteOption
            name="Alex Morgan"
            avatarColor={colors.violet}
            onPress={() => setSelectedPlayer("Alex Morgan")}
            selected={selectedPlayer === "Alex Morgan"}
          />
          <VoteOption
            name="Jordan Lee"
            avatarColor={colors.teal}
            onPress={() => setSelectedPlayer("Jordan Lee")}
            selected={selectedPlayer === "Jordan Lee"}
          />
          <VoteOption
            name="Sam Rivera"
            avatarColor={colors.blue}
            onPress={noop}
            out
          />
        </Section>

        <Section title="Game card">
          <GameCard
            icon={Eye}
            title="Classic mode"
            subtitle="Find the impostor among your friends."
            chipLabel="PARTY"
            tileColor={colors.softViolet}
            chipVariant="teal"
            onPress={noop}
          />
        </Section>

        <Section title="Inputs">
          <Text style={styles.inputHint}>Enter a four-letter room code</Text>
          <CodeInput value={code} onChangeText={setCode} />
          <TextField
            label="Nickname"
            value={nickname}
            onChangeText={setNickname}
            placeholder="Enter your nickname"
          />
        </Section>

        <Section title="Icon and map controls">
          <View style={styles.iconRow}>
            <IconButton
              icon={Settings}
              onPress={noop}
              accessibilityLabel="Settings"
            />
            <IconButton
              icon={Bell}
              onPress={noop}
              accessibilityLabel="Notifications"
            />
            <IconButton
              icon={Compass}
              onPress={noop}
              accessibilityLabel="Compass"
              disabled
            />
          </View>
          <MapActionButton
            icon={MapPin}
            label="Reveal location"
            subLabel="Available in 20 seconds"
            accentColor={colors.pink}
            onPress={noop}
          />
          <MapBanner message="Next location reveal" timer="00:20" />
        </Section>
      </View>
    </Screen>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function noop(): void {}

const styles = StyleSheet.create({
  content: {
    gap: spacing.xxl,
    paddingTop: spacing.xl,
  },
  header: {
    gap: spacing.xs,
  },
  eyebrow: {
    ...typography.label,
    color: colors.teal,
  },
  pageTitle: {
    ...typography.title,
    color: colors.text,
  },
  description: {
    ...typography.small,
    color: colors.textMuted,
  },
  section: {
    gap: spacing.md,
  },
  sectionTitle: {
    ...typography.gameCardTitle,
    color: colors.text,
  },
  panelTitle: {
    ...typography.body,
    color: colors.text,
  },
  panelCopy: {
    ...typography.small,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  playerPanel: {
    gap: spacing.md,
  },
  divider: {
    height: 1,
    backgroundColor: colors.panelDivider,
  },
  avatarRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  inputHint: {
    ...typography.small,
    color: colors.textMuted,
  },
  iconRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
});
