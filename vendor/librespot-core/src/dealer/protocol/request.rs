use crate::{
    deserialize_with::*,
    protocol::{
        context::Context,
        context_player_options::ContextPlayerOptionOverrides,
        player::{PlayOrigin, ProvidedTrack},
        transfer_state::TransferState,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    fmt::{Display, Formatter},
};

#[derive(Clone, Debug, Deserialize)]
pub struct Request {
    pub message_id: u32,
    // todo: did only send target_alias_id: null so far, maybe we just ignore it, will see
    // pub target_alias_id: Option<()>,
    pub sent_by_device_id: String,
    pub command: Command,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "endpoint", rename_all = "snake_case")]
pub enum Command {
    Transfer(TransferCommand),
    #[serde(deserialize_with = "boxed")]
    Play(Box<PlayCommand>),
    Pause(PauseCommand),
    SeekTo(SeekToCommand),
    SetShufflingContext(SetValueCommand),
    SetRepeatingTrack(SetValueCommand),
    SetRepeatingContext(SetValueCommand),
    AddToQueue(AddToQueueCommand),
    SetQueue(SetQueueCommand),
    SetOptions(SetOptionsCommand),
    UpdateContext(UpdateContextCommand),
    SkipNext(SkipNextCommand),
    // commands that don't send any context (at least not usually...)
    SkipPrev(GenericCommand),
    Resume(GenericCommand),
    // catch unknown commands, so that we can implement them later
    #[serde(untagged)]
    Unknown(Value),
}

impl Display for Command {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        use Command::*;

        write!(
            f,
            "endpoint: {}{}",
            matches!(self, Unknown(_))
                .then_some("unknown ")
                .unwrap_or_default(),
            match self {
                Transfer(_) => "transfer",
                Play(_) => "play",
                Pause(_) => "pause",
                SeekTo(_) => "seek_to",
                SetShufflingContext(_) => "set_shuffling_context",
                SetRepeatingContext(_) => "set_repeating_context",
                SetRepeatingTrack(_) => "set_repeating_track",
                AddToQueue(_) => "add_to_queue",
                SetQueue(_) => "set_queue",
                SetOptions(_) => "set_options",
                UpdateContext(_) => "update_context",
                SkipNext(_) => "skip_next",
                SkipPrev(_) => "skip_prev",
                Resume(_) => "resume",
                Unknown(json) => {
                    json.as_object()
                        .and_then(|obj| obj.get("endpoint").map(|v| v.as_str()))
                        .flatten()
                        .unwrap_or("???")
                }
            }
        )
    }
}

/// Names a command that didn't parse: its endpoint and top-level keys. The
/// values are left out, they can carry playback state and account data.
/// Reads a field Spotify may send as null or in another shape than the
/// desktop client's (as social-connect does for Jam guests): anything that
/// does not fit falls back to the default, so the command still parses.
fn lenient<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned + Default,
{
    let value = Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

/// A transfer option as text, whether sent as a string, a boolean or a
/// number.
fn lenient_text<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(match Value::deserialize(deserializer)? {
        Value::String(text) => Some(text),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    })
}

/// A parse error with anything in quotes or backticks replaced, so no
/// value from the command reaches a log.
fn redact_quotes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut quote = None;
    for character in text.chars() {
        match quote {
            Some(open) if character == open => {
                out.push('…');
                out.push(character);
                quote = None;
            }
            Some(_) => {}
            None if character == '"' || character == '`' => {
                out.push(character);
                quote = Some(character);
            }
            None => out.push(character),
        }
    }
    out
}

/// The JSON shape of a value without its contents, for logs.
fn shape(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(_) => "bool".to_owned(),
        Value::Number(_) => "number".to_owned(),
        Value::String(_) => "string".to_owned(),
        Value::Array(_) => "array".to_owned(),
        Value::Object(map) => {
            let mut keys: Vec<String> = map
                .iter()
                .map(|(key, value)| match value {
                    Value::Object(_) => format!("{key}: object"),
                    other => format!("{key}: {}", shape(other)),
                })
                .collect();
            keys.sort_unstable();
            format!("{{{}}}", keys.join(", "))
        }
    }
}

pub fn describe_unknown(command: &Value) -> String {
    let Some(object) = command.as_object() else {
        return "non-object command".to_owned();
    };
    let endpoint = object
        .get("endpoint")
        .and_then(Value::as_str)
        .unwrap_or("???");
    let mut keys: Vec<String> = object
        .iter()
        .filter(|(key, _)| *key != "endpoint")
        .map(|(key, value)| match (key.as_str(), value) {
            // Only the shape of data's contents, never the contents.
            ("data", Value::String(_)) => "data: string".to_owned(),
            (key, value) => format!("{key}: {}", shape(value)),
        })
        .collect();
    keys.sort_unstable();
    // Why a known endpoint did not parse, with any quoted values removed.
    let reason = match endpoint {
        "transfer" => serde_json::from_value::<TransferCommand>(command.clone()).err(),
        _ => None,
    }
    .map(|error| format!(": {}", redact_quotes(&error.to_string())))
    .unwrap_or_default();
    format!(
        "endpoint '{endpoint}' with keys [{}]{reason}",
        keys.join(", ")
    )
}

#[derive(Clone, Debug, Deserialize)]
pub struct TransferCommand {
    #[serde(default, deserialize_with = "base64_proto")]
    pub data: Option<TransferState>,
    // Spotify's Jam service (social-connect) leaves these out of the
    // transfers it sends to guests.
    #[serde(default, deserialize_with = "lenient")]
    pub options: TransferOptions,
    #[serde(default, deserialize_with = "lenient")]
    pub from_device_identifier: String,
    #[serde(default, deserialize_with = "lenient")]
    pub logging_params: LoggingParams,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PlayCommand {
    #[serde(deserialize_with = "json_proto")]
    pub context: Context,
    #[serde(deserialize_with = "json_proto")]
    pub play_origin: PlayOrigin,
    pub options: PlayOptions,
    #[serde(default, deserialize_with = "lenient")]
    pub logging_params: LoggingParams,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PauseCommand {
    // does send options with it, but seems to be empty, investigate which options are send here
    #[serde(default, deserialize_with = "lenient")]
    pub logging_params: LoggingParams,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SeekToCommand {
    pub value: u32,
    #[serde(default)]
    pub position: u32,
    #[serde(default, deserialize_with = "lenient")]
    pub logging_params: LoggingParams,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SkipNextCommand {
    #[serde(default, deserialize_with = "option_json_proto")]
    pub track: Option<ProvidedTrack>,
    #[serde(default, deserialize_with = "lenient")]
    pub logging_params: LoggingParams,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SetValueCommand {
    pub value: bool,
    #[serde(default, deserialize_with = "lenient")]
    pub logging_params: LoggingParams,
}

#[derive(Clone, Debug, Deserialize)]
pub struct AddToQueueCommand {
    #[serde(deserialize_with = "json_proto")]
    pub track: ProvidedTrack,
    #[serde(default, deserialize_with = "lenient")]
    pub logging_params: LoggingParams,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SetQueueCommand {
    #[serde(deserialize_with = "vec_json_proto")]
    pub next_tracks: Vec<ProvidedTrack>,
    #[serde(deserialize_with = "vec_json_proto")]
    pub prev_tracks: Vec<ProvidedTrack>,
    // this queue revision is actually the last revision, so using it will not update the web ui
    // might be that internally they use the last revision to create the next revision
    pub queue_revision: String,
    #[serde(default, deserialize_with = "lenient")]
    pub logging_params: LoggingParams,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SetOptionsCommand {
    pub shuffling_context: Option<bool>,
    pub repeating_context: Option<bool>,
    pub repeating_track: Option<bool>,
    pub options: Option<OptionsOptions>,
    /// Session modes, such as `{"jam": "on"}` sent by Spotify's Jam service.
    #[serde(default, deserialize_with = "lenient")]
    pub modes: Option<HashMap<String, String>>,
    #[serde(default, deserialize_with = "lenient")]
    pub logging_params: LoggingParams,
}

#[derive(Clone, Debug, Deserialize)]
pub struct UpdateContextCommand {
    #[serde(deserialize_with = "json_proto")]
    pub context: Context,
    pub session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct GenericCommand {
    #[serde(default, deserialize_with = "lenient")]
    pub logging_params: LoggingParams,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct TransferOptions {
    #[serde(
        default,
        deserialize_with = "lenient_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub restore_paused: Option<String>,
    #[serde(
        default,
        deserialize_with = "lenient_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub restore_position: Option<String>,
    #[serde(
        default,
        deserialize_with = "lenient_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub restore_track: Option<String>,
    #[serde(
        default,
        deserialize_with = "lenient_text",
        skip_serializing_if = "Option::is_none"
    )]
    pub retain_session: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PlayOptions {
    pub skip_to: Option<SkipTo>,
    #[serde(default, deserialize_with = "option_json_proto")]
    pub player_options_override: Option<ContextPlayerOptionOverrides>,
    pub license: Option<String>,
    // possible to send wie web-api
    pub seek_to: Option<u32>,
    // mobile
    pub always_play_something: Option<bool>,
    pub audio_stream: Option<String>,
    pub initially_paused: Option<bool>,
    pub prefetch_level: Option<String>,
    pub system_initiated: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct OptionsOptions {
    #[serde(default)]
    only_for_local_device: bool,
    #[serde(default)]
    override_restrictions: bool,
    #[serde(default)]
    system_initiated: bool,
}

#[derive(Clone, Debug, Deserialize, Default)]
pub struct SkipTo {
    pub track_uid: Option<String>,
    pub track_uri: Option<String>,
    pub track_index: Option<u32>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct LoggingParams {
    pub interaction_ids: Option<Vec<String>>,
    pub device_identifier: Option<String>,
    pub command_initiated_time: Option<i64>,
    pub page_instance_ids: Option<Vec<String>>,
    pub command_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, prelude::BASE64_STANDARD};
    use protobuf::Message;
    use serde_json::json;

    fn command(value: Value) -> Command {
        serde_json::from_value(value).expect("command parses")
    }

    #[test]
    fn a_jam_transfer_without_options_or_logging_params_is_a_transfer() {
        let mut state = TransferState::new();
        state.playback.mut_or_insert_default().timestamp = Some(1_000);
        state
            .playback
            .mut_or_insert_default()
            .current_track
            .mut_or_insert_default()
            .uri = Some("spotify:track:0000000000000000000001".into());
        state
            .current_session
            .mut_or_insert_default()
            .context
            .mut_or_insert_default()
            .uri = Some("spotify:list:jam-list:0123abcd".into());
        let data = BASE64_STANDARD.encode(state.write_to_bytes().unwrap());

        let Command::Transfer(transfer) = command(json!({
            "endpoint": "transfer",
            "data": data,
        })) else {
            panic!("not a transfer");
        };
        let state = transfer.data.expect("transfer data");
        assert_eq!(
            state.current_session.context.uri.as_deref(),
            Some("spotify:list:jam-list:0123abcd")
        );
        assert!(transfer.options.retain_session.is_none());
        assert!(transfer.from_device_identifier.is_empty());

        let Command::Transfer(transfer) = command(json!({
            "endpoint": "transfer",
            "data": data,
            "options": {"retain_session": "retain_original"},
        })) else {
            panic!("not a transfer");
        };
        assert_eq!(
            transfer.options.retain_session.as_deref(),
            Some("retain_original")
        );
    }

    #[test]
    fn set_options_with_only_modes_parses() {
        let Command::SetOptions(options) = command(json!({
            "endpoint": "set_options",
            "modes": {"jam": "on"},
        })) else {
            panic!("not set_options");
        };
        assert_eq!(
            options.modes.unwrap().get("jam").map(String::as_str),
            Some("on")
        );
        assert!(options.shuffling_context.is_none());
    }

    #[test]
    fn transport_commands_without_logging_params_parse() {
        assert!(matches!(
            command(json!({"endpoint": "pause"})),
            Command::Pause(_)
        ));
        assert!(matches!(
            command(json!({"endpoint": "skip_next"})),
            Command::SkipNext(_)
        ));
        assert!(matches!(
            command(json!({"endpoint": "skip_prev"})),
            Command::SkipPrev(_)
        ));
        assert!(matches!(
            command(json!({"endpoint": "resume"})),
            Command::Resume(_)
        ));
        let Command::SeekTo(seek) = command(json!({"endpoint": "seek_to", "value": 4200})) else {
            panic!("not seek_to");
        };
        assert_eq!(seek.value, 4200);
    }

    #[test]
    fn an_unknown_endpoint_stays_unknown_and_is_described_without_values() {
        let unknown = command(json!({
            "endpoint": "something_new",
            "secret_looking": "do-not-print",
            "data": "AAAA",
        }));
        let Command::Unknown(ref value) = unknown else {
            panic!("should be unknown");
        };
        assert_eq!(unknown.to_string(), "endpoint: unknown something_new");
        let described = describe_unknown(value);
        assert_eq!(
            described,
            "endpoint 'something_new' with keys [data: string, secret_looking: string]"
        );
        assert!(!described.contains("do-not-print"));
    }

    #[test]
    fn a_transfer_that_fails_says_why_without_its_values() {
        let value = json!({"endpoint": "transfer", "data": "not base64 secret!"});
        let described = describe_unknown(&value);
        assert!(described.starts_with("endpoint 'transfer' with keys [data: string]: "));
        assert!(!described.contains("secret"));
    }

    #[test]
    fn a_jam_transfer_with_null_or_odd_fields_still_parses() {
        // Every key present, as social-connect sent it to a Lyssna guest,
        // but in shapes the desktop client never uses.
        for (options, from, logging) in [
            (Value::Null, Value::Null, Value::Null),
            (
                json!({"retain_session": "retain_original", "restore_paused": true}),
                json!(""),
                json!({"command_initiated_time": "1793322390275", "interaction_ids": null}),
            ),
            (json!([]), json!(7), json!("none")),
        ] {
            let parsed = command(json!({
                "endpoint": "transfer",
                "data": "",
                "options": options,
                "from_device_identifier": from,
                "logging_params": logging,
            }));
            assert!(
                matches!(parsed, Command::Transfer(_)),
                "should be a transfer: {parsed}"
            );
        }
        let Command::Transfer(transfer) = command(json!({
            "endpoint": "transfer",
            "options": {"retain_session": "retain_original", "restore_paused": true},
            "from_device_identifier": null,
            "logging_params": null,
        })) else {
            panic!("should be a transfer");
        };
        assert_eq!(
            transfer.options.retain_session.as_deref(),
            Some("retain_original")
        );
        assert_eq!(transfer.options.restore_paused.as_deref(), Some("true"));
    }
}
