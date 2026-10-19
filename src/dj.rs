//! Independently implemented DJ prompt wire format. See THIRD_PARTY_NOTICES.md.
mod context;
#[cfg(windows)]
mod local_speech;
#[cfg(windows)]
mod microphone;
pub mod requests;
pub mod transport;
pub mod voice;

use anyhow::{Result, ensure};
use base64::{Engine, prelude::BASE64_STANDARD};
use serde::Deserialize;

pub const MAX_PROMPT_CHARS: usize = 500;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptInput {
    Text,
    Voice,
}

/// Only the reviewed transcript or typed prompt is sent, never microphone audio.
pub struct Prompt {
    text: String,
    input: PromptInput,
}

impl Prompt {
    pub fn new(text: &str, input: PromptInput) -> Result<Self> {
        let text = text.trim();
        ensure!(!text.is_empty(), "Enter a request for DJ");
        ensure!(
            text.chars().count() <= MAX_PROMPT_CHARS,
            "DJ requests must be 500 characters or fewer"
        );
        ensure!(
            !text.chars().any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t')),
            "DJ request contains unsupported control characters"
        );
        Ok(Self {
            text: text.into(),
            input,
        })
    }

    /// PromptSignalPayload: UTF-8 prompt in field 1; input enum in field 2.
    pub fn parameters(&self) -> Result<String> {
        let mut bytes = Vec::new();
        {
            let mut output = protobuf::CodedOutputStream::vec(&mut bytes);
            output.write_string(1, &self.text)?;
            output.write_enum(
                2,
                match self.input {
                    PromptInput::Text => 2,
                    PromptInput::Voice => 1,
                },
            )?;
            output.flush()?;
        }
        Ok(BASE64_STANDARD.encode(bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_payload_matches_the_observed_text_and_voice_wire_format() {
        let text = Prompt::new("  jazz  ", PromptInput::Text).unwrap();
        assert_eq!(
            BASE64_STANDARD.decode(text.parameters().unwrap()).unwrap(),
            b"\x0a\x04jazz\x10\x02"
        );
        let voice = Prompt::new("jazz", PromptInput::Voice).unwrap();
        assert_eq!(
            BASE64_STANDARD.decode(voice.parameters().unwrap()).unwrap(),
            b"\x0a\x04jazz\x10\x01"
        );
    }

    #[test]
    fn unicode_prompts_use_utf8_byte_lengths_and_multibyte_varints() {
        let text = "音".repeat(MAX_PROMPT_CHARS);
        let prompt = Prompt::new(&text, PromptInput::Text).unwrap();
        let bytes = BASE64_STANDARD
            .decode(prompt.parameters().unwrap())
            .unwrap();
        let mut reader = protobuf::CodedInputStream::from_bytes(&bytes);
        assert_eq!(reader.read_raw_tag_or_eof().unwrap(), Some(10));
        assert_eq!(reader.read_string().unwrap(), text);
        assert_eq!(reader.read_raw_tag_or_eof().unwrap(), Some(16));
        assert_eq!(reader.read_int32().unwrap(), 2);
        assert!(reader.eof().unwrap());
    }

    #[test]
    fn invalid_prompts_are_rejected_before_any_network_request() {
        for value in [
            "".to_owned(),
            " \n\t ".to_owned(),
            "a".repeat(MAX_PROMPT_CHARS + 1),
            "jazz\0music".to_owned(),
        ] {
            assert!(Prompt::new(&value, PromptInput::Text).is_err());
        }
    }
}
