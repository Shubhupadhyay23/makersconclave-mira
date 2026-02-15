"""Integration tests for MCP protocol layer.

These tests verify that the FastMCP server exposes the correct tools with proper schemas.
Tests use FastMCP's Client to communicate with the server via the MCP protocol.

IMPORTANT: These tests are currently skipped due to a known import conflict.
The local backend/mcp/ directory shadows the PyPI mcp package that fastmcp depends on.
See CLAUDE.md for details on the import issue.
"""

import pytest

# Test if we can import the dependencies
try:
    from mcp_server.server import _create_mcp_server
    from fastmcp import Client
    IMPORTS_AVAILABLE = True
    SKIP_REASON = None
except (ImportError, ModuleNotFoundError) as e:
    IMPORTS_AVAILABLE = False
    SKIP_REASON = (
        f"MCP integration tests skipped due to import conflict: {e}. "
        "The local backend/mcp/ directory shadows the PyPI mcp package."
    )

pytestmark = pytest.mark.skipif(not IMPORTS_AVAILABLE, reason=SKIP_REASON)


@pytest.mark.asyncio
async def test_mcp_server_lists_both_tools():
    """Test that the MCP server exposes exactly the two expected tools."""
    if not IMPORTS_AVAILABLE:
        pytest.skip(SKIP_REASON)

    # Create the MCP server instance
    mcp_server = _create_mcp_server()

    # Use FastMCP's Client to list tools via MCP protocol
    async with Client(mcp_server) as client:
        tools = await client.list_tools()

        # Extract tool names
        tool_names = {tool.name for tool in tools.tools}

        # Verify exactly these two tools are present
        assert tool_names == {"get_past_sessions", "save_session"}, (
            f"Expected exactly {{get_past_sessions, save_session}}, "
            f"but got {tool_names}"
        )


@pytest.mark.asyncio
async def test_tool_schemas_have_phone_param():
    """Test that both tools have a required 'phone' parameter in their input schema."""
    if not IMPORTS_AVAILABLE:
        pytest.skip(SKIP_REASON)

    # Create the MCP server instance
    mcp_server = _create_mcp_server()

    # Use FastMCP's Client to list tools via MCP protocol
    async with Client(mcp_server) as client:
        tools = await client.list_tools()

        # Check each tool
        for tool in tools.tools:
            assert tool.name in {"get_past_sessions", "save_session"}, (
                f"Unexpected tool: {tool.name}"
            )

            # Verify the tool has an input schema
            assert tool.inputSchema is not None, (
                f"Tool {tool.name} has no inputSchema"
            )

            # The inputSchema should be a dict-like object with a 'properties' field
            schema = tool.inputSchema
            assert "properties" in schema, (
                f"Tool {tool.name} inputSchema has no 'properties' field"
            )

            # Verify 'phone' parameter exists
            properties = schema["properties"]
            assert "phone" in properties, (
                f"Tool {tool.name} is missing 'phone' parameter in schema"
            )

            # Verify 'phone' is required
            assert "required" in schema, (
                f"Tool {tool.name} inputSchema has no 'required' field"
            )
            required_params = schema["required"]
            assert "phone" in required_params, (
                f"Tool {tool.name} does not mark 'phone' as required. "
                f"Required params: {required_params}"
            )
