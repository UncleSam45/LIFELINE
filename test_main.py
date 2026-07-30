import subprocess
from pathlib import Path
from unittest import mock

import main


def test_support_services_launch_ollama_before_memory_manager():
    with mock.patch.object(main, "_launch_ollama") as ollama, mock.patch.object(
        main, "_launch_memory_manager"
    ) as memory:
        manager = mock.Mock()
        manager.attach_mock(ollama, "ollama")
        manager.attach_mock(memory, "memory")

        main._launch_support_services()

        assert manager.mock_calls == [mock.call.ollama(), mock.call.memory()]


def test_launch_ollama_uses_serve_for_cli_binary():
    with mock.patch.object(main, "_ollama_is_running", return_value=False), mock.patch.object(
        main, "_ollama_executable", return_value=Path("/opt/bin/ollama")
    ), mock.patch.object(main, "_spawn_background") as spawn:
        main._launch_ollama()

    spawn.assert_called_once_with(["/opt/bin/ollama", "serve"], "ollama.log")


def test_launch_memory_manager_uses_current_python():
    with mock.patch.object(Path, "is_file", return_value=True), mock.patch.object(
        main, "_spawn_background"
    ) as spawn:
        main._launch_memory_manager()

    spawn.assert_called_once_with(
        [main.sys.executable, str(main.MEMORY_MANAGER_PATH)], "memory-manager.log"
    )


def test_spawn_background_closes_parent_log_stream():
    log = mock.Mock()
    with mock.patch.object(main, "_background_process_options", return_value=({}, log)), mock.patch.object(
        subprocess, "Popen", return_value=mock.sentinel.process
    ) as popen:
        result = main._spawn_background(["service"], "service.log")

    assert result is mock.sentinel.process
    popen.assert_called_once_with(["service"])
    log.close.assert_called_once_with()
