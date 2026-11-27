import { useRef, useState } from "react";
import {
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import type {
  TextInputInstance,
  TextInputKeyPressEvent,
} from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { useTranslation } from "../i18n/use-translation";
import { colors, radii, spacing, typography } from "../theme";

const CODE_LENGTH = 4;

interface CodeInputProps {
  value: string;
  onChangeText: (value: string) => void;
  accessibilityLabelForIndex?: (index: number, total: number) => string;
  style?: StyleProp<ViewStyle>;
}

export function CodeInput({
  value,
  onChangeText,
  accessibilityLabelForIndex,
  style,
}: CodeInputProps) {
  const t = useTranslation();
  const inputs = useRef<Array<TextInputInstance | null>>([]);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const characters = sanitizeCode(value).split("");

  const handleChange = (index: number, input: string) => {
    const targetIndex =
      !characters[index] && index > characters.length
        ? characters.length
        : index;
    const enteredCharacters = sanitizeCode(input).slice(
      0,
      CODE_LENGTH - targetIndex,
    );
    if (enteredCharacters.length === 0) {
      const nextCharacters = [...characters];
      nextCharacters[targetIndex] = "";
      onChangeText(nextCharacters.join(""));
      return;
    }

    const nextCharacters = Array.from(
      { length: CODE_LENGTH },
      (_, characterIndex) => characters[characterIndex] ?? "",
    );
    enteredCharacters.split("").forEach((character, characterOffset) => {
      nextCharacters[targetIndex + characterOffset] = character;
    });
    onChangeText(nextCharacters.join(""));

    const nextIndex = targetIndex + enteredCharacters.length;
    if (nextIndex < CODE_LENGTH) {
      inputs.current[nextIndex]?.focus();
    }
  };

  const handleKeyPress = (
    index: number,
    event: TextInputKeyPressEvent,
  ) => {
    if (
      event.nativeEvent.key === "Backspace" &&
      !characters[index] &&
      index > 0
    ) {
      inputs.current[index - 1]?.focus();
    }
  };

  return (
    <View style={[styles.row, style]}>
      {Array.from({ length: CODE_LENGTH }, (_, index) => (
        <TextInput
          key={index}
          ref={(input) => {
            inputs.current[index] = input;
          }}
          accessibilityLabel={
            accessibilityLabelForIndex?.(index + 1, CODE_LENGTH) ??
            t("common.roomCodeCharacter", {
              current: index + 1,
              total: CODE_LENGTH,
            })
          }
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={1}
          onBlur={() => setFocusedIndex(null)}
          onChangeText={(input) => handleChange(index, input)}
          onFocus={() => setFocusedIndex(index)}
          onKeyPress={(event) => handleKeyPress(index, event)}
          returnKeyType={index === CODE_LENGTH - 1 ? "done" : "next"}
          selectionColor={colors.teal}
          style={[
            styles.box,
            focusedIndex === index ? styles.activeBox : null,
          ]}
          value={characters[index] ?? ""}
        />
      ))}
    </View>
  );
}

function sanitizeCode(value: string): string {
  return value.replace(/[^a-z]/gi, "").toUpperCase().slice(0, CODE_LENGTH);
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "center",
    gap: spacing.sm,
  },
  box: {
    width: 72,
    height: 72,
    padding: 0,
    textAlign: "center",
    color: colors.teal,
    backgroundColor: colors.panel,
    borderRadius: radii.input,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    ...typography.codeInput,
  },
  activeBox: {
    borderColor: colors.teal,
    backgroundColor: colors.tealTint,
  },
});
