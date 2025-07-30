# Objective

Create the ability to edit a server config. Editing a server config will open the edit server modal. The edit server modal will have all the fields of the server its editing already filled out. Allow the user to edit and save the new configuration.

## Create the EditServerModal component

Create a component `EditServerModal` in `src/components/connection/EditServerModal.tsx`. This modal should have the same structure as `AddServerModal`, but it should be able to take in a server config and pre-fill the form. Allow the user to edit the form in the modal.

On submit, delete the original server and connect to an MCP with the new config.

## Create edit server entry point

Create a button right below the "Reconnect" option in the component `ServerConnectionCard.tsx` called "edit". Clicking on the button will open up the `EditServerModal`.

# Additional instructions

Propose how to do this before implementing for approval
